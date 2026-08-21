import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/app.js";
import { markdownTableDefinition, splitMarkdownTableRow } from "../public/markdown.js";

const execFileAsync = promisify(execFile);

// 身份就是 email;带 provider 表示以该 email 名下的那个 AI 身份行动。没有 token。
const asMember = (email, provider = null) => (provider
  ? { "X-Relay-Email": email, "X-Relay-Provider": provider }
  : { "X-Relay-Email": email });
const relayClient = path.resolve("bin/relay-client.js");
const codexWorker = path.resolve("bin/codex-worker.js");
const codexHook = path.resolve("bin/codex-hook.js");
const codexHookInstaller = path.resolve("bin/install-codex-hooks.js");
const mcpServer = path.resolve("bin/mcp-server.js");

test("parses Markdown tables including alignment and escaped pipes", () => {
  const definition = markdownTableDefinition([
    "| 项 | 结果 | 备注 |",
    "|:---|:---:|---:|"
  ], 0);
  assert.deepEqual(definition, {
    headers: ["项", "结果", "备注"],
    alignments: ["left", "center", "right"]
  });
  assert.deepEqual(
    splitMarkdownTableRow("| `check|safe.sh` | BE\\|FE no changes |"),
    ["`check|safe.sh`", "BE|FE no changes"]
  );
  assert.equal(markdownTableDefinition(["| 不是 | 表格 |", "| -- | -- |"], 0), null);
});

async function execFileWithInput(file, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `Process exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-relay-"));
  const { app, store, sweepExpiredTokens, sweepUnanswered, movedTo, pushEverythingToNewServer } = await createApp({
    dataDir,
    publicBaseUrl: "http://relay.test",
    ...options
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, dataDir, sweepExpiredTokens, sweepUnanswered, movedTo, pushEverythingToNewServer };
}

async function json(base, url, options = {}) {
  const response = await fetch(`${base}${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  return { response, body: await response.json() };
}

test("creates a group, joins via invitation and exchanges messages", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Architecture", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.inviteUrl, /\/join\//);

  const inviteToken = created.body.group.inviteToken;
  const missingOwner = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ name: "Codex", type: "ai", provider: "codex" })
  });
  assert.equal(missingOwner.response.status, 400);

  const joined = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com", name: "Codex", type: "ai", provider: "codex" })
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.member.provider, "codex");
  assert.equal(joined.body.member.ownerName, "Yunfei");

  const form = new FormData();
  form.set("text", "Hello from Codex");
  form.set("files", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
  const sentResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
    body: form
  });
  assert.equal(sentResponse.status, 201);

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.length, 1);
  assert.equal(history.body.messages[0].text, "Hello from Codex");
  assert.equal(history.body.messages[0].sender.ownerName, "Yunfei");
  assert.equal(history.body.messages[0].attachments[0].name, "notes.txt");
});

test("rejects history access from identities that are not in the group", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Private", email: "owner@example.com", displayName: "Owner" })
  });
  // 没有鉴权,但也不是随便谁都算成员:不带身份或带一个陌生 email 都是 404。
  const anonymous = await fetch(`${base}/api/groups/${created.body.group.id}/messages`);
  assert.equal(anonymous.status, 404);
  const stranger = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    headers: { "X-Relay-Email": "stranger@example.com" }
  });
  assert.equal(stranger.status, 404);
});

test("email accounts import validated browser sessions and list joined groups", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "iOS group", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "YUNFEI.CAO@example.com" })
  });
  assert.equal(account.response.status, 201);
  assert.equal(account.body.account.email, "yunfei.cao@example.com");
  assert.equal(account.body.account.displayName, "yunfei.cao");
  assert.ok(account.body.account.email);

  const duplicate = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "yunfei.cao@example.com" })
  });
  assert.equal(duplicate.response.status, 201);
  assert.equal(duplicate.body.account.email, account.body.account.email);

  const imported = await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers: { "X-Relay-Email": account.body.account.email },
    body: JSON.stringify({
      sessions: [
        {
          groupId: created.body.group.id
        },
        {
          groupId: "00000000-0000-4000-8000-000000000000"
        }
      ]
    })
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.imported, 1);
  assert.equal(imported.body.rejected.length, 1);
  assert.equal(imported.body.sessions[0].group.name, "iOS group");
  assert.equal(imported.body.sessions[0].member.name, "yunfei.cao");
  assert.equal(imported.body.sessions[0].email, account.body.account.email);

  const avatarDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const profile = await json(base, "/api/account", {
    method: "PATCH",
    headers: { "X-Relay-Email": account.body.account.email },
    body: JSON.stringify({ displayName: "Zoe", avatarDataUrl })
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.account.displayName, "Zoe");
  assert.equal(profile.body.account.avatarDataUrl, avatarDataUrl);

  const listed = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": account.body.account.email }
  });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.sessions.length, 1);
  assert.equal(listed.body.sessions[0].member.name, "Zoe");

  const unauthorized = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "nobody@example.com" }
  });
  assert.equal(unauthorized.response.status, 404);
});

test("desktop account AI can join a linked group, answer every member and leave", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Desktop AI Group", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com" })
  });
  const accountHeaders = { "X-Relay-Email": account.body.account.email };
  await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({
      sessions: [{ groupId: created.body.group.id }]
    })
  });

  const attached = await json(base, `/api/account/sessions/${created.body.group.id}/ais`, {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({ provider: "codex" })
  });
  assert.equal(attached.response.status, 201);
  assert.equal(attached.body.member.ownerName, "Yunfei");
  assert.equal(attached.body.member.trustedExecutionEnabled, true);
  assert.equal(attached.body.worker.provider, "codex");
  assert.equal(attached.body.worker.groupId, created.body.group.id);
  assert.ok(attached.body.worker.email);

  const guest = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "guest@example.com", name: "Guest", type: "human" })
  });
  const guestMessage = new FormData();
  guestMessage.set("text", "@Yunfei’s Codex 帮我解释一下");
  guestMessage.set("mentions", JSON.stringify([attached.body.member.id]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(guest.body.member.email, guest.body.member.provider) },
    body: guestMessage
  });
  const ownerMessage = new FormData();
  ownerMessage.set("text", "@Yunfei’s Codex 修改项目并测试");
  ownerMessage.set("mentions", JSON.stringify([attached.body.member.id]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: ownerMessage
  });
  const routed = await json(base, `/api/groups/${created.body.group.id}/messages?routed=1`, {
    headers: { ...asMember(attached.body.worker.email, attached.body.worker.provider) }
  });
  // 开了免审批之后,群里其他人的消息落在只读档:能让这个 AI 干只读的活,改本机仍要主人批。
  // 免审批 = 群内所有人全权:客人的指令也直接执行(设备主人明确要求的行为)。
  assert.deepEqual(routed.body.messages.map((message) => message.executionScope), ["trusted", "trusted"]);

  const sessions = await json(base, "/api/account/sessions", { headers: accountHeaders });
  assert.equal(sessions.body.sessions[0].desktopAis.length, 1);
  assert.equal(sessions.body.sessions[0].desktopAis[0].provider, "codex");

  const removed = await json(
    base,
    `/api/account/sessions/${created.body.group.id}/ais/codex`,
    { method: "DELETE", headers: accountHeaders }
  );
  assert.equal(removed.body.disconnected, true);
  const group = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(group.body.members.some((member) => member.type === "ai"), false);
});

test("a guest account can attach its desktop AI to somebody else's group", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Somebody else's group", email: "owner@example.com", displayName: "Owner" })
  });
  const guest = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yunfei-guest@example.test", name: "Yunfei", type: "human" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "yunfei-guest@example.test" })
  });
  const headers = { "X-Relay-Email": account.body.account.email };
  await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessions: [{ groupId: created.body.group.id }] })
  });

  const attached = await json(base, `/api/account/sessions/${created.body.group.id}/ais`, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "codex" })
  });
  assert.equal(attached.response.status, 201);
  assert.equal(attached.body.member.ownerName, "Yunfei");
  assert.equal(attached.body.member.trustedExecutionEnabled, false);

  const desired = await json(base, "/api/account/desktop-workers", { headers });
  assert.equal(desired.response.status, 200);
  assert.equal(desired.body.workers.length, 1);
  assert.equal(desired.body.workers[0].groupId, created.body.group.id);
  assert.equal(desired.body.workers[0].provider, "codex");
  assert.ok(desired.body.workers[0].email);

  const guestView = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(guest.body.member.email, guest.body.member.provider) }
  });
  assert.equal(
    guestView.body.members.find((member) => member.id === attached.body.member.id).canManageTrustedExecution,
    true
  );
  const ownerView = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(
    ownerView.body.members.find((member) => member.id === attached.body.member.id).canManageTrustedExecution,
    false
  );
  const ownerDenied = await json(
    base,
    `/api/groups/${created.body.group.id}/members/${attached.body.member.id}/trusted-execution`,
    {
      method: "POST",
      headers: { ...asMember(created.body.member.email, created.body.member.provider) },
      body: JSON.stringify({ enabled: true })
    }
  );
  assert.equal(ownerDenied.response.status, 403);
  const enabled = await json(
    base,
    `/api/groups/${created.body.group.id}/members/${attached.body.member.id}/trusted-execution`,
    {
      method: "POST",
      headers: { ...asMember(guest.body.member.email, guest.body.member.provider) },
      body: JSON.stringify({ enabled: true })
    }
  );
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.member.trustedExecutionEnabled, true);
  const guestMessage = new FormData();
  guestMessage.set("text", "@Yunfei’s Codex 修改项目");
  guestMessage.set("mentions", JSON.stringify([attached.body.member.id]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(guest.body.member.email, guest.body.member.provider) },
    body: guestMessage
  });
  const routed = await json(base, `/api/groups/${created.body.group.id}/messages?routed=1`, {
    headers: { ...asMember(attached.body.worker.email, attached.body.worker.provider) }
  });
  assert.equal(routed.body.messages.at(-1).executionScope, "trusted");
});

test("trusted desktop AIs from the same owner can delegate work to each other", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "AI delegation", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  // 两个 AI 要挂在同一个主人名下、且那位就是群主,免审批才成立 ——
  // 原来这个用例是靠导入群主的 member token 达成的,现在直接用同一个 email。
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com" })
  });
  const accountHeaders = { "X-Relay-Email": account.body.account.email };
  await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({
      sessions: [{ groupId: created.body.group.id }]
    })
  });
  const cursor = await json(base, `/api/account/sessions/${created.body.group.id}/ais`, {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({ provider: "cursor" })
  });
  const claude = await json(base, `/api/account/sessions/${created.body.group.id}/ais`, {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({ provider: "claude" })
  });

  const delegated = new FormData();
  delegated.set("text", "@Yunfei’s Claude 按主管要求完成开发");
  delegated.set("mentions", JSON.stringify([claude.body.member.id]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(cursor.body.worker.email, cursor.body.worker.provider) },
    body: delegated
  });

  const routed = await json(base, `/api/groups/${created.body.group.id}/messages?routed=1`, {
    headers: { ...asMember(claude.body.worker.email, claude.body.worker.provider) }
  });
  assert.equal(routed.body.messages.length, 1);
  assert.equal(routed.body.messages[0].executionScope, "trusted");
});

test("desktop AI approval requests appear in the owner queue and batch approval redelivers once as trusted", async (t) => {
  const { base, store } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Approval queue", email: "other.owner@example.com", displayName: "Other owner" })
  });
  const yunfei = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com", name: "Yunfei", type: "human" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "yunfei-approvals@example.test" })
  });
  const accountHeaders = { "X-Relay-Email": account.body.account.email };
  await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({
      sessions: [{ groupId: created.body.group.id }]
    })
  });
  const attached = await json(base, `/api/account/sessions/${created.body.group.id}/ais`, {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({ provider: "claude" })
  });
  const command = new FormData();
  command.set("text", "请读取本机项目并运行测试");
  command.set("mentions", JSON.stringify([attached.body.member.id]));
  const commandResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: command
  });
  const commandBody = await commandResponse.json();
  const requested = await json(base, `/api/groups/${created.body.group.id}/approvals`, {
    method: "POST",
    headers: { ...asMember(attached.body.worker.email, attached.body.worker.provider) },
    body: JSON.stringify({
      sourceMessageId: commandBody.message.id,
      summary: "读取项目并运行测试"
    })
  });
  assert.equal(requested.response.status, 201);

  const inbox = await json(base, "/api/account/approvals", { headers: accountHeaders });
  assert.equal(inbox.body.pendingCount, 1);
  assert.equal(inbox.body.approvals[0].group.name, "Approval queue");
  assert.equal(inbox.body.approvals[0].aiMember.provider, "claude");

  const resolved = await json(base, "/api/account/approvals/resolve", {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({ approvalIds: [requested.body.approval.id], action: "approve" })
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.body.results[0].status, "approved");
  assert.equal(resolved.body.approvals[0].status, "approved");

  const routed = await json(base, `/api/groups/${created.body.group.id}/messages?routed=1`, {
    headers: { ...asMember(attached.body.worker.email, attached.body.worker.provider) }
  });
  const redelivery = routed.body.messages.find((message) => message.approval?.id === requested.body.approval.id);
  assert.ok(redelivery);
  assert.equal(redelivery.executionScope, "trusted");
  assert.equal(redelivery.mentions[0].id, attached.body.member.id);
  // 原文是按 sourceMessageId 从缓冲区取的,审批单里不再存正文副本。
  assert.equal(redelivery.text, "【已批准执行】请读取本机项目并运行测试");
  assert.equal(requested.body.approval.source, undefined);

  // 待审批的审批单活得比保留期长时,原文已经被清掉:退回 AI 自己写的 summary,不能直接失败。
  const laterApproval = await json(base, `/api/groups/${created.body.group.id}/approvals`, {
    method: "POST",
    headers: { ...asMember(attached.body.worker.email, attached.body.worker.provider) },
    body: JSON.stringify({ sourceMessageId: commandBody.message.id, summary: "缓冲区已经没有原文了" })
  });
  assert.equal(laterApproval.response.status, 201);
  const messagesDir = path.join(store.groupDir(created.body.group.id), "messages");
  for (const name of await fs.readdir(messagesDir)) await fs.rm(path.join(messagesDir, name));
  await json(base, "/api/account/approvals/resolve", {
    method: "POST",
    headers: accountHeaders,
    body: JSON.stringify({ approvalIds: [laterApproval.body.approval.id], action: "approve" })
  });
  const afterPurge = await json(base, `/api/groups/${created.body.group.id}/messages?routed=1`, {
    headers: { ...asMember(attached.body.worker.email, attached.body.worker.provider) }
  });
  const fallback = afterPurge.body.messages
    .find((message) => message.approval?.id === laterApproval.body.approval.id);
  assert.equal(fallback.text, "【已批准执行】缓冲区已经没有原文了");
});

test("one-click browser transfer imports sessions into the current account", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Chrome session", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "one-click@example.com" })
  });
  const transfer = await json(base, "/api/account/browser-transfers", {
    method: "POST",
    headers: { "X-Relay-Email": account.body.account.email },
    body: "{}"
  });
  assert.equal(transfer.response.status, 201);
  assert.match(transfer.body.transferUrl, /\/transfer\//);

  const imported = await json(base, `/api/browser-transfers/${transfer.body.transferToken}/import`, {
    method: "POST",
    body: JSON.stringify({
      sessions: [{
        groupId: created.body.group.id
      }]
    })
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.status, "completed");
  assert.equal(imported.body.imported, 1);

  const status = await json(base, `/api/account/browser-transfers/${transfer.body.transferToken}`, {
    headers: { "X-Relay-Email": account.body.account.email }
  });
  assert.equal(status.body.status, "completed");

  const reused = await json(base, `/api/browser-transfers/${transfer.body.transferToken}/import`, {
    method: "POST",
    body: JSON.stringify({ sessions: [] })
  });
  assert.equal(reused.response.status, 409);

  const sessions = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": account.body.account.email }
  });
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].group.name, "Chrome session");
});

test("desktop client creates a one-time web login for the same account", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Desktop synced group", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "desktop-web@example.com" })
  });
  const headers = { "X-Relay-Email": account.body.account.email };
  await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessions: [{ groupId: created.body.group.id }]
    })
  });

  const login = await json(base, "/api/account/web-logins", {
    method: "POST",
    headers,
    body: "{}"
  });
  assert.equal(login.response.status, 201);
  assert.match(login.body.loginUrl, /\/web-login\//);

  const claimed = await json(base, `/api/web-logins/${login.body.loginToken}/claim`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.body.account.email, "desktop-web@example.com");
  assert.equal(claimed.body.email, account.body.account.email);

  const sessions = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": claimed.body.account.email }
  });
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].group.name, "Desktop synced group");

  const replayed = await json(base, `/api/web-logins/${login.body.loginToken}/claim`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(replayed.response.status, 409);
});

test("account AI board tracks Jira assignments through AI completion", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Yunfei Tasks", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com", name: "Codex", type: "ai", provider: "codex" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com" })
  });
  await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers: { "X-Relay-Email": account.body.account.email },
    body: JSON.stringify({
      sessions: [{ groupId: created.body.group.id }]
    })
  });

  const assignment = new FormData();
  assignment.set("text", "@Yunfei’s Codex 完成登录修复 https://acme.atlassian.net/browse/APP-123");
  assignment.set("mentions", JSON.stringify([joined.body.member.id]));
  const assignmentResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: assignment
  });
  const assignmentBody = await assignmentResponse.json();
  assert.equal(assignmentResponse.status, 201);

  let board = await json(base, "/api/account/tasks", {
    headers: { "X-Relay-Email": account.body.account.email }
  });
  assert.equal(board.body.tasks.length, 1);
  assert.equal(board.body.tasks[0].jira.key, "APP-123");
  assert.equal(board.body.tasks[0].status, "assigned");
  assert.equal(board.body.summary.assigned, 1);

  const placeholder = new FormData();
  placeholder.set("text", "正在处理这个 Jira，请稍等…");
  placeholder.set("status", "processing");
  placeholder.set("replyTo", assignmentBody.message.id);
  const placeholderResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
    body: placeholder
  });
  const placeholderBody = await placeholderResponse.json();
  board = await json(base, "/api/account/tasks", {
    headers: { "X-Relay-Email": account.body.account.email }
  });
  assert.equal(board.body.tasks[0].status, "in_progress");

  await json(base, `/api/groups/${created.body.group.id}/messages/${placeholderBody.message.id}`, {
    method: "PATCH",
    headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
    body: JSON.stringify({ text: "APP-123 已完成并通过测试。", status: "complete" })
  });
  board = await json(base, "/api/account/tasks", {
    headers: { "X-Relay-Email": account.body.account.email }
  });
  assert.equal(board.body.tasks[0].status, "completed");
  // 看板只存 id 引用,正文不落服务端 —— 客户端按这个 id 回本机记录里取。
  assert.equal(board.body.tasks[0].responseMessageId, placeholderBody.message.id);
  assert.equal(board.body.tasks[0].report, undefined);
  assert.equal(board.body.tasks[0].title, undefined);
  assert.equal(board.body.summary.completed, 1);
});

test("long polling delivers a new message without refreshing", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Realtime", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const memberEmail = created.body.member.email;
  const waitRequest = fetch(`${base}/api/groups/${groupId}/messages/wait?timeoutMs=2000`, {
    headers: { ...asMember(memberEmail) }
  }).then(async (response) => ({ response, body: await response.json() }));

  await new Promise((resolve) => setTimeout(resolve, 50));
  const form = new FormData();
  form.set("text", "live message");
  const sent = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: { ...asMember(memberEmail) },
    body: form
  });
  assert.equal(sent.status, 201);

  const waited = await waitRequest;
  assert.equal(waited.response.status, 200);
  assert.equal(waited.body.messages.length, 1);
  assert.equal(waited.body.messages[0].text, "live message");
});

test("long polling delivers AI presence events without treating them as messages", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Presence Events", email: "owner@example.com", displayName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "yunfei@example.com",
      name: "Codex",
      type: "ai",
      provider: "codex",
    })
  });
  const waitRequest = json(
    base,
    `/api/groups/${created.body.group.id}/messages/wait?timeoutMs=2000`,
    { headers: { ...asMember(created.body.member.email, created.body.member.provider) } }
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  await json(base, `/api/groups/${created.body.group.id}/members/me/presence`, {
    method: "POST",
    headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
    body: JSON.stringify({ status: "busy" })
  });

  const waited = await waitRequest;
  assert.equal(waited.body.event, "member_presence");
  assert.equal(waited.body.eventPayload.id, joined.body.member.id);
  assert.equal(waited.body.eventPayload.presence.status, "busy");
  assert.deepEqual(waited.body.messages, []);
});

test("routes @AI messages only to the mentioned AI", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Mentions", email: "owner@example.com", displayName: "Owner" })
  });
  const inviteToken = created.body.group.inviteToken;
  const codex = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "yunfei@example.com",
      name: "Codex",
      type: "ai",
      provider: "codex",
    })
  });
  const claude = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "zoe@example.com",
      name: "Claude",
      type: "ai",
      provider: "claude",
    })
  });

  const form = new FormData();
  form.set("text", "@Yunfei’s Codex 请回答这个问题");
  form.set("mentions", JSON.stringify([codex.body.member.id]));
  const sentResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: form
  });
  assert.equal(sentResponse.status, 201);
  const sent = await sentResponse.json();
  assert.equal(sent.message.mentions[0].id, codex.body.member.id);

  const forCodex = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { ...asMember(codex.body.member.email, codex.body.member.provider) } }
  );
  assert.equal(forCodex.body.messages.length, 1);
  assert.equal(forCodex.body.messages[0].text, "@Yunfei’s Codex 请回答这个问题");

  const forClaude = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { ...asMember(claude.body.member.email, claude.body.member.provider) } }
  );
  assert.equal(forClaude.body.messages.length, 0);
  assert.equal(forClaude.body.cursor, sent.message.id);

  const placeholder = new FormData();
  placeholder.set("text", "正在处理这个问题，请稍等…");
  placeholder.set("status", "processing");
  const placeholderResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(codex.body.member.email, codex.body.member.provider) },
    body: placeholder
  });
  assert.equal(placeholderResponse.status, 201);

  const placeholderForClaude = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { ...asMember(claude.body.member.email, claude.body.member.provider) } }
  );
  assert.equal(placeholderForClaude.body.messages.length, 0);

  const aiMention = new FormData();
  aiMention.set("text", "@Zoe’s Claude 请协助核对");
  aiMention.set("mentions", JSON.stringify([claude.body.member.id]));
  const aiMentionResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(codex.body.member.email, codex.body.member.provider) },
    body: aiMention
  });
  assert.equal(aiMentionResponse.status, 201);

  const explicitForClaude = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { ...asMember(claude.body.member.email, claude.body.member.provider) } }
  );
  assert.equal(explicitForClaude.body.messages.length, 1);
  assert.equal(explicitForClaude.body.messages[0].text, "@Zoe’s Claude 请协助核对");
});

test("allows mentioning a human group member", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Human mentions", email: "owner@example.com", displayName: "Owner" })
  });
  const guest = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "guest@example.com", name: "Guest", type: "human" })
  });
  const form = new FormData();
  form.set("text", "@Guest 请看一下");
  form.set("mentions", JSON.stringify([guest.body.member.id]));
  const response = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: form
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.message.mentions[0].id, guest.body.member.id);
  assert.equal(body.message.mentions[0].name, "Guest");
});

test("the group owner can grant trusted execution to a legacy AI", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Trusted workspace", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const inviteToken = created.body.group.inviteToken;
  const ai = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com", name: "Cursor", type: "ai", provider: "cursor" })
  });
  const guest = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "guest@example.com", name: "Guest", type: "human" })
  });

  const denied = await json(
    base,
    `/api/groups/${created.body.group.id}/members/${ai.body.member.id}/trusted-execution`,
    {
      method: "POST",
      headers: { ...asMember(guest.body.member.email, guest.body.member.provider) },
      body: JSON.stringify({ enabled: true })
    }
  );
  assert.equal(denied.response.status, 403);

  const enabled = await json(
    base,
    `/api/groups/${created.body.group.id}/members/${ai.body.member.id}/trusted-execution`,
    {
      method: "POST",
      headers: { ...asMember(created.body.member.email, created.body.member.provider) },
      body: JSON.stringify({ enabled: true })
    }
  );
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.member.trustedExecutionEnabled, true);
  assert.equal("trustedOwnerMemberId" in enabled.body.member, false);

  for (const [member, text] of [
    [created.body.member, "owner command"],
    [guest.body.member, "guest command"]
  ]) {
    const form = new FormData();
    form.set("text", text);
    form.set("mentions", JSON.stringify([ai.body.member.id]));
    await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
      method: "POST",
      headers: { ...asMember(member.email, member.provider) },
      body: form
    });
  }

  const routed = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { ...asMember(ai.body.member.email, ai.body.member.provider) } }
  );
  assert.deepEqual(
    routed.body.messages.map((message) => [message.text, message.executionScope]),
    [["owner command", "trusted"], ["guest command", "trusted"]]
  );
});

test("AI presence changes from busy to offline when heartbeats expire", async (t) => {
  const { base } = await fixture(t, { presenceTimeoutMs: 30 });
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Presence", email: "owner@example.com", displayName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "yunfei@example.com",
      name: "Codex",
      type: "ai",
      provider: "codex",
    })
  });
  const busy = await json(
    base,
    `/api/groups/${created.body.group.id}/members/me/presence`,
    {
      method: "POST",
      headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
      body: JSON.stringify({ status: "busy" })
    }
  );
  assert.equal(busy.body.presence.status, "busy");

  const active = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(active.body.members.find((member) => member.type === "ai").presence.status, "busy");

  await new Promise((resolve) => setTimeout(resolve, 40));
  const expired = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(expired.body.members.find((member) => member.type === "ai").presence.status, "offline");
});

test("AI reconnect marks interrupted processing placeholders as failed", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Interrupted work", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com", name: "Codex", type: "ai", provider: "codex" })
  });
  const headers = { ...asMember(joined.body.member.email, joined.body.member.provider) };
  const placeholder = new FormData();
  placeholder.set("text", "正在处理…");
  placeholder.set("status", "processing");
  const sent = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers,
    body: placeholder
  });
  assert.equal(sent.status, 201);

  const online = await json(base, `/api/groups/${created.body.group.id}/members/me/presence`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "online", recoverInterrupted: true })
  });
  assert.equal(online.response.status, 200);
  assert.equal(online.body.presence.status, "online");

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.length, 1);
  assert.equal(history.body.messages[0].status, "failed");
  assert.match(history.body.messages[0].text, /客户端重启或连接中断/);
});

test("AI polling renews presence and routed work marks it busy", async (t) => {
  const { base } = await fixture(t, { presenceTimeoutMs: 1500 });
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Polling Presence", email: "owner@example.com", displayName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "yunfei@example.com",
      name: "Codex",
      type: "ai",
      provider: "codex",
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 1600));
  await json(
    base,
    `/api/groups/${created.body.group.id}/messages/wait?timeoutMs=1000&routed=1`,
    { headers: { ...asMember(joined.body.member.email, joined.body.member.provider) } }
  );
  const online = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(online.body.members.find((member) => member.type === "ai").presence.status, "online");

  const form = new FormData();
  form.set("text", "@Codex are you there?");
  form.set("mentions", JSON.stringify([joined.body.member.id]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: form
  });
  await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { ...asMember(joined.body.member.email, joined.body.member.provider) } }
  );
  const busy = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(busy.body.members.find((member) => member.type === "ai").presence.status, "busy");
});

test("AI processing placeholders stay busy and are updated in place", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Processing", email: "owner@example.com", displayName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "yunfei@example.com",
      name: "Codex",
      type: "ai",
      provider: "codex",
    })
  });
  const placeholderForm = new FormData();
  placeholderForm.set("text", "正在处理这个问题，请稍等…");
  placeholderForm.set("status", "processing");
  const placeholderResponse = await fetch(
    `${base}/api/groups/${created.body.group.id}/messages`,
    {
      method: "POST",
      headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
      body: placeholderForm
    }
  );
  const placeholder = await placeholderResponse.json();
  assert.equal(placeholder.message.status, "processing");

  const attemptedOnline = await json(base, `/api/groups/${created.body.group.id}/members/me/presence`, {
    method: "POST",
    headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
    body: JSON.stringify({ status: "online" })
  });
  assert.equal(attemptedOnline.body.presence.status, "busy");
  const stillBusy = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(stillBusy.body.members.find((member) => member.type === "ai").presence.status, "busy");

  const waitForUpdate = json(
    base,
    `/api/groups/${created.body.group.id}/messages/wait?after=${placeholder.message.id}&timeoutMs=2000`,
    { headers: { ...asMember(created.body.member.email, created.body.member.provider) } }
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const completed = await json(
    base,
    `/api/groups/${created.body.group.id}/messages/${placeholder.message.id}`,
    {
      method: "PATCH",
      headers: { ...asMember(joined.body.member.email, joined.body.member.provider) },
      body: JSON.stringify({
        text: "这是完整答案",
        status: "complete",
        expectedGroupId: created.body.group.id
      })
    }
  );
  assert.equal(completed.body.message.id, placeholder.message.id);

  const updateEvent = await waitForUpdate;
  assert.equal(updateEvent.body.event, "message_updated");
  assert.equal(updateEvent.body.eventPayload.text, "这是完整答案");

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.length, 1);
  assert.equal(history.body.messages[0].text, "这是完整答案");
  assert.equal(history.body.messages[0].status, "complete");
  const online = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(online.body.members.find((member) => member.type === "ai").presence.status, "online");
});

test("AI relay client joins, persists identity, receives and sends messages", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Agent Group", email: "owner@example.com", displayName: "Owner" })
  });
  const inviteUrl = created.body.inviteUrl.replace("http://relay.test", base);
  const configFile = path.join(dataDir, "agent-config.json");
  const clientEnv = { ...process.env, GROUP_RELAY_AGENT_CONFIG: configFile };
  const joined = await execFileAsync(process.execPath, [
    relayClient,
    "join",
    inviteUrl,
    "--provider",
    "codex",
    "--owner",
    "Yunfei",
    "--email",
    "yunfei@example.com",
    "--name",
    "Codex"
  ], { env: clientEnv });
  const joinedBody = JSON.parse(joined.stdout);
  assert.equal(joinedBody.connected, true);
  assert.equal(joinedBody.member.displayName, "Yunfei’s Codex");
  await fs.access(configFile);

  const ownerMessage = new FormData();
  ownerMessage.set("text", "Please review the latest change");
  const ownerSent = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: ownerMessage
  });
  assert.equal(ownerSent.status, 201);

  const waited = await execFileAsync(process.execPath, [
    relayClient,
    "wait",
    "--timeout",
    "2000"
  ], { env: clientEnv });
  const waitedBody = JSON.parse(waited.stdout);
  assert.equal(waitedBody.messages.length, 1);
  assert.equal(waitedBody.messages[0].text, "Please review the latest change");
  const busyState = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(busyState.body.members.find((member) => member.type === "ai").presence.status, "busy");

  const reply = await execFileAsync(process.execPath, [
    relayClient,
    "send",
    "Review complete"
  ], { env: clientEnv });
  assert.equal(JSON.parse(reply.stdout).message.text, "Review complete");
  const onlineState = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(onlineState.body.members.find((member) => member.type === "ai").presence.status, "online");

  const clientStatus = await execFileAsync(process.execPath, [
    relayClient,
    "status"
  ], { env: clientEnv });
  assert.doesNotMatch(clientStatus.stdout, /inviteToken/);
});

test("relay named connections read the correct group and reject cross-group sends", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Named Connection", email: "owner@example.com", displayName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "yunfei@example.com",
      name: "Codex",
      type: "ai",
      provider: "codex",
    })
  });
  const codexHome = path.join(dataDir, "codex-home");
  await fs.mkdir(codexHome);
  await fs.writeFile(path.join(codexHome, "config.toml"), `
[mcp_servers.group-relay-named]
command = "node"

[mcp_servers.group-relay-named.env]
GROUP_RELAY_URL = "${base}"
GROUP_RELAY_GROUP_ID = "${created.body.group.id}"
GROUP_RELAY_EMAIL = "${joined.body.member.email}"
`);
  const clientEnv = { ...process.env, CODEX_HOME: codexHome };
  // 读也要对齐群:命名连接下不说明「我以为我在哪个群」就不给读,说错了更不给 ——
  // 串群就是这么发生的(拿 B 群的历史回答 A 群的问题)。
  await assert.rejects(
    execFileAsync(process.execPath, [
      relayClient, "history", "--connection", "group-relay-named"
    ], { env: clientEnv }),
    /--expected-group is required/
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      relayClient, "history", "--connection", "group-relay-named",
      "--expected-group", "00000000-0000-4000-8000-000000000000"
    ], { env: clientEnv }),
    /Refusing to read/
  );
  const history = await execFileAsync(process.execPath, [
    relayClient,
    "history",
    "--connection",
    "group-relay-named",
    "--expected-group",
    created.body.group.id
  ], { env: clientEnv });
  assert.equal(JSON.parse(history.stdout).group.name, "Named Connection");
  assert.equal(JSON.parse(history.stdout).group.id, created.body.group.id);

  await assert.rejects(
    execFileAsync(process.execPath, [
      relayClient,
      "send",
      "--connection",
      "group-relay-named",
      "--expected-group",
      "00000000-0000-4000-8000-000000000000",
      "must not send"
    ], { env: clientEnv }),
    /Refusing to send/
  );
});

test("Codex worker consumes a routed message and posts the generated reply", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Worker Group", email: "owner@example.com", displayName: "Owner" })
  });
  const configFile = path.join(dataDir, "worker-config.json");
  const fakeCodex = path.join(dataDir, "fake-codex");
  await fs.writeFile(fakeCodex, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    printf '%s\\n' '常驻 Worker 已自动回复' > "$1"
    exit 0
  fi
  shift
done
exit 1
`, { mode: 0o700 });
  const workerEnv = { ...process.env, GROUP_RELAY_AGENT_CONFIG: configFile };

  const joined = await execFileAsync(process.execPath, [
    relayClient,
    "join",
    created.body.inviteUrl.replace("http://relay.test", base),
    "--provider",
    "codex",
    "--owner",
    "Yunfei",
    "--email",
    "yunfei@example.com",
    "--name",
    "Codex"
  ], { env: workerEnv });
  const aiMemberId = JSON.parse(joined.stdout).member.id;

  const question = new FormData();
  question.set("text", "@Codex 请回复");
  question.set("mentions", JSON.stringify([aiMemberId]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: question
  });

  await execFileAsync(process.execPath, [
    codexWorker,
    "--once",
    "--codex-bin",
    fakeCodex
  ], { env: workerEnv, timeout: 10_000 });

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.at(-1).text, "常驻 Worker 已自动回复");
  assert.equal(history.body.messages.at(-1).sender.id, aiMemberId);
  assert.equal(history.body.messages.at(-1).status, "complete");
});

test("the cross-platform worker keeps a Claude session online without any desktop client", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Headless Group", email: "owner@example.com", displayName: "Owner" })
  });
  const configFile = path.join(dataDir, "headless-session.json");
  // claude 走 stdout(没有 -o 文件),这是 codex 之外的另一条取回复路径
  const fakeClaude = path.join(dataDir, "fake-claude");
  await fs.writeFile(fakeClaude, `#!/bin/sh
printf '%s\\n' '命令行 worker 已回复'
exit 0
`, { mode: 0o700 });
  const workerEnv = {
    ...process.env,
    GROUP_RELAY_AGENT_CONFIG: configFile,
    // 别碰真机的注册表
    GROUP_RELAY_LOCAL_WORKERS: path.join(dataDir, "local-workers.json")
  };

  const joined = await execFileAsync(process.execPath, [
    relayClient, "join", created.body.inviteUrl.replace("http://relay.test", base),
    "--provider", "claude", "--owner", "Yunfei", "--email", "yunfei@example.com", "--name", "Claude"
  ], { env: workerEnv });
  const aiMemberId = JSON.parse(joined.stdout).member.id;

  const question = new FormData();
  question.set("text", "@Claude 没有桌面客户端也该有人应");
  question.set("mentions", JSON.stringify([aiMemberId]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: question
  });

  const ran = await execFileAsync(process.execPath, [
    relayClient, "worker", "--once", "--agent-bin", fakeClaude
  ], { env: workerEnv, timeout: 20_000 });
  assert.equal(JSON.parse(ran.stdout).handled, 1);

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  const reply = history.body.messages.at(-1);
  assert.equal(reply.text, "命令行 worker 已回复");
  assert.equal(reply.sender.id, aiMemberId);
  assert.equal(reply.status, "complete");
  // 原地回填:占位和最终回复是同一条消息,不是两条
  assert.equal(reply.replyTo, history.body.messages.at(-2).id);
  // 原地回填:这条问题只换来一条 AI 消息(占位被改写),不是占位 + 回复两条。
  // 群里另有一条是 join 时的「已加入群聊」通告,所以按 replyTo 数,不按发送者数。
  assert.equal(
    history.body.messages.filter((message) => message.replyTo === reply.replyTo).length,
    1
  );
  // cursor 落盘了,重启之后不会把同一条再跑一遍
  const saved = JSON.parse(await fs.readFile(configFile, "utf8"));
  assert.ok(saved.cursor);
});

test("system messages carry key + values so each reader sees their own language", async (t) => {
  /// 一条存下来的文本没法同时满足两种语言:主人切成英文,群里的中文同事也会看到英文。
  /// 所以这几条有限模板除了渲染好的 text,再存一份 {key, values},客户端用自己的语言重渲染 ——
  /// 这是精确渲染,不是机器翻译,用的就是前后端共用的那张表。
  const { base, sweepUnanswered } = await fixture(t, { unansweredMinutes: 10, giveUpMinutes: 45 });
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "双语系统消息", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
  });
  const aiId = "ai:owner@example.com:claude";
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: owner,
    body: new URLSearchParams({ text: "@Claude 看一下", mentions: JSON.stringify([aiId]) })
  });
  await sweepUnanswered(Date.now() + 11 * 60_000);

  const history = await json(base, `/api/groups/${groupId}/messages`, { headers: owner });
  const fallback = history.body.messages.at(-1);
  assert.match(fallback.text, /没有接到这条任务/);
  assert.ok(fallback.i18n, "系统消息要带 i18n,否则读者只能看写它时定死的那一种语言");
  assert.match(fallback.i18n.key, /没有接到这条任务（已过 \{0\} 分钟）/);
  assert.equal(fallback.i18n.values.length, 2);
  assert.equal(fallback.i18n.values[1], "Owner");
  // 客户端用同一张字典 + 自己的 locale 重渲染,应当得到英文
  const { translate } = await import("../src/i18n.js");
  const asEnglish = translate("en", fallback.i18n.key, fallback.i18n.values);
  assert.match(asEnglish, /Nobody picked this up \(11 min ago\)/);
  assert.doesNotMatch(asEnglish, /[一-鿿]/);
});

test("a message can carry both languages and a shared data block", async (t) => {
  /// 平台只负责存和切换:双语正文由写答案的那个 AI 自己给出(它本来就懂这些术语),
  /// 群内容一步都不离开这套系统,不接任何第三方翻译服务。
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "双语正文", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
  });
  const ai = { ...owner, "X-Relay-Provider": "claude" };

  const sent = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({
      text: "通过率掉了 3 个点。",
      bodies: JSON.stringify({ zh: "通过率掉了 3 个点。", en: "Approval rate dropped 3 points." }),
      // 数字和表格是语言中立的:两版共用,别让模型把数据重打一遍
      shared: "| day | rate |\n| --- | --- |\n| 08-20 | 71.2% |"
    })
  }).then((response) => response.json());
  assert.deepEqual(sent.message.bodies, {
    zh: "通过率掉了 3 个点。",
    en: "Approval rate dropped 3 points."
  });
  assert.match(sent.message.shared, /71\.2%/);
  // text 一字不动:老客户端和历史记录照旧
  assert.equal(sent.message.text, "通过率掉了 3 个点。");

  // 原地回填时也能把占位换成双语答案
  const placeholder = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: ai, body: new URLSearchParams({ text: "正在处理…", status: "processing" })
  }).then((response) => response.json());
  const patched = await json(base, `/api/groups/${groupId}/messages/${placeholder.message.id}`, {
    method: "PATCH",
    headers: ai,
    body: JSON.stringify({
      text: "查完了。",
      status: "complete",
      bodies: { zh: "查完了。", en: "Done." },
      expectedGroupId: groupId
    })
  });
  assert.deepEqual(patched.body.message.bodies, { zh: "查完了。", en: "Done." });

  // 半截结构不许进消息:客户端拿它当渲染依据
  const rejected = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "x", bodies: JSON.stringify({ fr: "Bonjour" }) })
  });
  assert.equal(rejected.status, 400);
  const emptyBodies = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "x", bodies: "{}" })
  });
  assert.equal(emptyBodies.status, 400);
});

test("language follows the account, and Accept-Language covers the rest", async (t) => {
  const { base, sweepUnanswered } = await fixture(t, { unansweredMinutes: 10 });
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Bilingual", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };

  /// 服务端也在发用户直接看得到的字符串,只翻前端解决不了。没有账号偏好时按请求头兜底。
  const zhError = await json(base, "/api/feedback", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ title: "x", body: "y" })
  });
  assert.equal(zhError.response.status, 403);
  assert.match(zhError.body.error, /反馈只接受 AI 提交/);
  const enError = await json(base, "/api/feedback", {
    method: "POST",
    headers: { ...owner, "Accept-Language": "en-GB,en;q=0.9" },
    body: JSON.stringify({ title: "x", body: "y" })
  });
  assert.equal(enError.response.status, 403);
  assert.match(enError.body.error, /Feedback is accepted from AIs only/);

  // 选择存在账号上,换设备也保持 —— 所以要能存下来并跟着账号下发
  const saved = await json(base, "/api/account", {
    method: "PATCH",
    headers: owner,
    body: JSON.stringify({ displayName: "Owner", avatarDataUrl: null, locale: "en" })
  });
  assert.equal(saved.body.account.locale, "en");
  const reread = await json(base, "/api/account", { headers: owner });
  assert.equal(reread.body.account.locale, "en");

  // 账号偏好优先于请求头:这次请求头明说中文,回的仍是英文
  const stillEnglish = await json(base, "/api/feedback", {
    method: "POST",
    headers: { ...owner, "Accept-Language": "zh-CN" },
    body: JSON.stringify({ title: "x", body: "y" })
  });
  assert.match(stillEnglish.body.error, /Feedback is accepted from AIs only/);

  /// 写进群聊的系统消息同样要跟语言 —— 它们会永久留在聊天记录里,英文用户不该在自己的
  /// 群里看到中文兜底提示。这条按 AI 主人的语言写。
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
  });
  const aiId = "ai:owner@example.com:claude";
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: owner,
    body: new URLSearchParams({ text: "@Claude anyone there", mentions: JSON.stringify([aiId]) })
  });
  assert.deepEqual(await sweepUnanswered(Date.now() + 11 * 60_000), { prompted: 1, nudged: 0, gaveUp: 0 });
  const history = await json(base, `/api/groups/${groupId}/messages`, { headers: owner });
  const fallback = history.body.messages.at(-1);
  assert.equal(fallback.status, "failed");
  assert.match(fallback.text, /Nobody picked this up/);
  assert.match(fallback.text, /ask Owner to check that machine/);
  assert.doesNotMatch(fallback.text, /[一-鿿]/);
});

test("an @-mention never goes silent: no pickup, stalled, and given up", async (t) => {
  /// 真实事故:有人在群里连问两条,三天里既没有回复、也没有「正在处理」或失败提示 ——
  /// 从群成员的视角完全分不清是 AI 在跑、任务丢了、还是整套 relay 挂了。执行端那时可能
  /// 已经退出/休眠/登录过期,它自己回不来,所以只能由服务端兜底。
  const { base, sweepUnanswered } = await fixture(t, {
    unansweredMinutes: 10,
    stallMinutes: 20,
    giveUpMinutes: 45
  });
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "不许石沉大海", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
  });
  const aiId = "ai:owner@example.com:claude";
  const ai = { ...owner, "X-Relay-Provider": "claude" };
  const ask = async (text) => (await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: owner,
    body: new URLSearchParams({ text, mentions: JSON.stringify([aiId]) })
  }).then((response) => response.json())).message;
  const historyFor = async (questionId) => {
    const history = await json(base, `/api/groups/${groupId}/messages`, { headers: owner });
    return history.body.messages.filter((message) => message.replyTo === questionId);
  };
  const minutesAgo = (minutes) => Date.now() + minutes * 60_000;

  // 1) 没人接单:过了阈值要替 AI 说一句「没接到,请重发」,并说清多半是执行端没在跑
  const dropped = await ask("@Claude 这条没人接");
  assert.deepEqual(await sweepUnanswered(minutesAgo(5)), { prompted: 0, nudged: 0, gaveUp: 0 });
  assert.equal((await historyFor(dropped.id)).length, 0);
  assert.deepEqual(await sweepUnanswered(minutesAgo(11)), { prompted: 1, nudged: 0, gaveUp: 0 });
  const fallback = (await historyFor(dropped.id))[0];
  assert.equal(fallback.sender.id, aiId);
  assert.equal(fallback.status, "failed");
  assert.match(fallback.text, /没有接到这条任务/);
  assert.match(fallback.text, /请重发/);
  // 兜底只发一次:它自己就是一条回复,下一轮不会再补
  assert.deepEqual(await sweepUnanswered(minutesAgo(30)), { prompted: 0, nudged: 0, gaveUp: 0 });
  assert.equal((await historyFor(dropped.id)).length, 1);

  // 2) 接了单但迟迟不回:提醒一次「仍在进行」,不改状态,也不重复提醒
  const slow = await ask("@Claude 这条很慢");
  const placeholder = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "正在处理…", status: "processing", replyTo: slow.id })
  }).then((response) => response.json());
  assert.deepEqual(await sweepUnanswered(minutesAgo(11)), { prompted: 0, nudged: 0, gaveUp: 0 });
  assert.deepEqual(await sweepUnanswered(minutesAgo(21)), { prompted: 0, nudged: 1, gaveUp: 0 });
  let pending = (await historyFor(slow.id))[0];
  assert.equal(pending.status, "processing");
  assert.match(pending.text, /仍在进行/);
  assert.deepEqual(await sweepUnanswered(minutesAgo(25)), { prompted: 0, nudged: 0, gaveUp: 0 });

  // 3) 再久就认定执行端没了:占位改成失败,并让提问的人重发
  assert.deepEqual(await sweepUnanswered(minutesAgo(46)), { prompted: 0, nudged: 0, gaveUp: 1 });
  pending = (await historyFor(slow.id))[0];
  assert.equal(pending.status, "failed");
  assert.match(pending.text, /请重发/);
  assert.equal(placeholder.message.id, pending.id, "同一条气泡原地改写,不新增噪音");
  // 收尾之后这个 AI 在本群不再算忙
  const view = await json(base, `/api/groups/${groupId}`, { headers: owner });
  assert.equal(view.body.members.find((member) => member.id === aiId).presence.status, "online");
  assert.deepEqual(await sweepUnanswered(minutesAgo(60)), { prompted: 0, nudged: 0, gaveUp: 0 });

  // 正常答完的提问不会被兜底打扰
  const answered = await ask("@Claude 这条正常");
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "答完了", status: "complete", replyTo: answered.id })
  });
  assert.deepEqual(await sweepUnanswered(minutesAgo(120)), { prompted: 0, nudged: 0, gaveUp: 0 });

  // AI 在那之后说过话(哪怕没带 replyTo,MCP 的 group_send 就常常不带)就不该兜底 ——
  // 上线第一分钟就因此误判过一条:某人一句空 @,AI 之后说了七八次话,还是被判「没接到任务」。
  const bare = await ask("@Claude");
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "在的,你要问什么?" })
  });
  assert.deepEqual(await sweepUnanswered(minutesAgo(30)), { prompted: 0, nudged: 0, gaveUp: 0 });
  assert.equal((await historyFor(bare.id)).length, 0);

  // 太老的提问不再补:第一次上线时不该把历史上所有没回过的 @ 一次性补满各个群
  const stale = await ask("@Claude 三天前的老问题");
  assert.deepEqual(await sweepUnanswered(minutesAgo(3 * 24 * 60)), { prompted: 0, nudged: 0, gaveUp: 0 });
  assert.equal((await historyFor(stale.id)).length, 0);
});

test("one AI in several groups keeps a separate presence per group", async (t) => {
  const { base } = await fixture(t);
  const owner = { "X-Relay-Email": "owner@example.com" };
  const groups = [];
  for (const name of ["A 群", "B 群"]) {
    const created = await json(base, "/api/groups", {
      method: "POST",
      body: JSON.stringify({ name, email: "owner@example.com", displayName: "Owner" })
    });
    await json(base, `/api/account/sessions/${created.body.group.id}/ais`, {
      method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
    });
    groups.push(created.body.group.id);
  }
  const [a, b] = groups;
  const memberId = "ai:owner@example.com:claude";
  const ai = { ...owner, "X-Relay-Provider": "claude" };
  const presenceIn = async (groupId) => {
    const view = await json(base, `/api/groups/${groupId}`, { headers: owner });
    return view.body.members.find((member) => member.id === memberId);
  };

  /// 一个 AI 进 N 个群 = N 个独立 worker。以前 presence 只按 memberId 存,任意一个群里在跑,
  /// 四个群一起显示「忙碌」;同一条记录里的 activeMessageIds 也串群,别的群的成员列表里会
  /// 出现指向本群消息的 id。
  const question = await fetch(`${base}/api/groups/${a}/messages`, {
    method: "POST", headers: owner, body: new URLSearchParams({ text: "A 群的问题" })
  }).then((response) => response.json());
  await fetch(`${base}/api/groups/${a}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "正在处理…", status: "processing", replyTo: question.message.id })
  });

  const inA = await presenceIn(a);
  const inB = await presenceIn(b);
  assert.equal(inA.presence.status, "busy");
  assert.equal(inB.presence.status, "online");
  assert.deepEqual(inA.activeMessageIds ?? [], []);
  assert.equal(inA.presence.lastSeenAt === inB.presence.lastSeenAt, false);

  // 反过来也一样:B 群报忙,A 群把自己那条任务收尾之后就回到 online,不被 B 拖住。
  await json(base, `/api/groups/${b}/members/me/presence`, {
    method: "POST", headers: ai, body: JSON.stringify({ status: "busy" })
  });
  const placeholderId = (await json(base, `/api/groups/${a}/messages`, { headers: owner }))
    .body.messages.at(-1).id;
  await json(base, `/api/groups/${a}/messages/${placeholderId}`, {
    method: "PATCH",
    headers: ai,
    body: JSON.stringify({ text: "答完了", status: "complete", expectedGroupId: a })
  });
  await json(base, `/api/groups/${a}/members/me/presence`, {
    method: "POST", headers: ai, body: JSON.stringify({ status: "online" })
  });
  assert.equal((await presenceIn(b)).presence.status, "busy");
  assert.equal((await presenceIn(a)).presence.status, "online");
});

test("routed polls say which group they are, and a mismatched worker refuses to answer", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "斗兽场", email: "owner@example.com", displayName: "Owner" })
  });
  const other = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "renew v4 特征", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
  });
  const ai = { ...owner, "X-Relay-Provider": "claude" };
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: owner, body: new URLSearchParams({ text: "这是斗兽场的问题" })
  });

  // routed 轮询必须回「这是哪个群」—— 桥接靠它把 groupId 钉进提示词,AI 才有对齐的依据
  const routed = await json(base, `/api/groups/${groupId}/messages?routed=1&limit=10`, { headers: ai });
  assert.deepEqual(routed.body.group, { id: groupId, name: "斗兽场" });
  assert.equal(routed.body.messages.every((message) => message.groupId === groupId), true);
  // 人的界面不需要这个字段,别白占带宽
  const humanView = await json(base, `/api/groups/${groupId}/messages?limit=10`, { headers: owner });
  assert.equal(humanView.body.group, undefined);

  // 接收端:配置指着另一个群时,worker 宁可停下也不能拿这个群的消息去回答
  const configFile = path.join(dataDir, "crossed-session.json");
  await fs.writeFile(configFile, JSON.stringify({
    baseUrl: base,
    groupId: other.body.group.id,
    email: "owner@example.com",
    provider: "claude",
    memberName: "Claude",
    ownerName: "Owner",
    sessionId: "crossed"
  }));
  const fakeClaude = path.join(dataDir, "fake-claude-crossed");
  await fs.writeFile(fakeClaude, "#!/bin/sh\nprintf 'never mind\\n'\n", { mode: 0o700 });
  const crossed = await execFileAsync(process.execPath, [
    relayClient, "worker", "--once", "--agent-bin", fakeClaude
  ], {
    env: {
      ...process.env,
      GROUP_RELAY_AGENT_CONFIG: configFile,
      GROUP_RELAY_LOCAL_WORKERS: path.join(dataDir, "local-workers.json")
    },
    timeout: 20_000
  });
  // 它轮的是自己那个群(空的),所以不该回答斗兽场的问题
  assert.equal(JSON.parse(crossed.stdout).handled, 0);
  const untouched = await json(base, `/api/groups/${groupId}/messages`, { headers: owner });
  assert.equal(untouched.body.messages.filter((message) => message.sender.type === "ai").length, 0);
});

test("the worker writes its chat-visible messages in the owner's language", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "English group", email: "owner@example.com", displayName: "Owner" })
  });
  const configFile = path.join(dataDir, "en-session.json");
  const failing = path.join(dataDir, "fake-claude-en");
  await fs.writeFile(failing, `#!/bin/sh
printf '%s\\n' 'OAuth session expired'
exit 1
`, { mode: 0o700 });
  const workerEnv = {
    ...process.env,
    GROUP_RELAY_AGENT_CONFIG: configFile,
    GROUP_RELAY_LOCAL_WORKERS: path.join(dataDir, "local-workers.json")
  };
  const joined = await execFileAsync(process.execPath, [
    relayClient, "join", created.body.inviteUrl.replace("http://relay.test", base),
    "--provider", "claude", "--owner", "Zoe", "--email", "zoe@example.com", "--name", "Claude"
  ], { env: workerEnv });
  const aiMemberId = JSON.parse(joined.stdout).member.id;
  // 上线播报默认中文(账号还没选语言)
  const afterJoin = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember("owner@example.com") }
  });
  assert.match(afterJoin.body.messages.at(-1).text, /已加入群聊/);

  // 主人把语言切成英文之后,占位和失败提示都要跟着 —— 这些都会永久留在聊天记录里
  await json(base, "/api/account", {
    method: "PATCH",
    headers: { "X-Relay-Email": "zoe@example.com" },
    body: JSON.stringify({ displayName: "Zoe", avatarDataUrl: null, locale: "en" })
  });
  const question = new FormData();
  question.set("text", "@Claude have a look");
  question.set("mentions", JSON.stringify([aiMemberId]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember("owner@example.com") },
    body: question
  });
  await execFileAsync(process.execPath, [
    relayClient, "worker", "--once", "--agent-bin", failing
  ], { env: workerEnv, timeout: 20_000 });

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember("owner@example.com") }
  });
  const failure = history.body.messages.at(-1);
  assert.equal(failure.status, "failed");
  assert.match(failure.text, /^Failed:/);
  assert.match(failure.text, /login has expired/);
  assert.doesNotMatch(failure.text, /[一-鿿]/);
});

test("a failed CLI reports why, not just an exit code", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "失败原因", email: "owner@example.com", displayName: "Owner" })
  });
  const configFile = path.join(dataDir, "failing-session.json");
  /// 真实事故:claude CLI 的登录过期,它把「Failed to authenticate: OAuth session expired」
  /// 打在 **stdout** 然后 exit 1,而桥接只报了「claude exited with status 1」——
  /// 群里看到的是一句没法行动的话。失败消息必须带上 CLI 自己说的原因。
  const failing = path.join(dataDir, "fake-claude-expired");
  await fs.writeFile(failing, `#!/bin/sh
printf '%s\\n' 'Failed to authenticate: OAuth session expired and could not be refreshed'
exit 1
`, { mode: 0o700 });
  const workerEnv = {
    ...process.env,
    GROUP_RELAY_AGENT_CONFIG: configFile,
    GROUP_RELAY_LOCAL_WORKERS: path.join(dataDir, "local-workers.json")
  };
  const joined = await execFileAsync(process.execPath, [
    relayClient, "join", created.body.inviteUrl.replace("http://relay.test", base),
    "--provider", "claude", "--owner", "Yunfei", "--email", "yunfei@example.com", "--name", "Claude"
  ], { env: workerEnv });
  const aiMemberId = JSON.parse(joined.stdout).member.id;
  const question = new FormData();
  question.set("text", "@Claude 查一下");
  question.set("mentions", JSON.stringify([aiMemberId]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: question
  });

  await execFileAsync(process.execPath, [
    relayClient, "worker", "--once", "--agent-bin", failing
  ], { env: workerEnv, timeout: 20_000 });

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  const failure = history.body.messages.at(-1);
  assert.equal(failure.status, "failed");
  assert.match(failure.text, /exited with status 1/);
  assert.match(failure.text, /OAuth session expired/);
  // 登录失效要说清该在哪台机器上做什么,否则群里的人只能干等
  assert.match(failure.text, /登录已失效/);
});

test("opencode joins as a fourth provider and answers through the resident worker", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "OpenCode Group", email: "owner@example.com", displayName: "Owner" })
  });
  const configFile = path.join(dataDir, "opencode-session.json");
  // 非交互模式必须是 `opencode run …`,受限档还要带 --agent plan(内置的只读 agent)
  const fakeOpencode = path.join(dataDir, "fake-opencode");
  await fs.writeFile(fakeOpencode, `#!/bin/sh
if [ "$1" = "run" ]; then
  printf '%s\\n' "opencode 已回复"
  exit 0
fi
exit 1
`, { mode: 0o700 });
  const workerEnv = {
    ...process.env,
    GROUP_RELAY_AGENT_CONFIG: configFile,
    GROUP_RELAY_LOCAL_WORKERS: path.join(dataDir, "local-workers.json")
  };

  const joined = await execFileAsync(process.execPath, [
    relayClient, "join", created.body.inviteUrl.replace("http://relay.test", base),
    "--provider", "opencode", "--owner", "Yunfei", "--email", "yunfei@example.com", "--name", "OpenCode"
  ], { env: workerEnv });
  const member = JSON.parse(joined.stdout).member;
  assert.equal(member.provider, "opencode");
  assert.equal(member.id, "ai:yunfei@example.com:opencode");

  const question = new FormData();
  question.set("text", "@OpenCode 在吗");
  question.set("mentions", JSON.stringify([member.id]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { ...asMember(created.body.member.email, created.body.member.provider) },
    body: question
  });

  const ran = await execFileAsync(process.execPath, [
    relayClient, "worker", "--once", "--agent-bin", fakeOpencode
  ], { env: workerEnv, timeout: 20_000 });
  assert.equal(JSON.parse(ran.stdout).handled, 1);

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.at(-1).text, "opencode 已回复");
  assert.equal(history.body.messages.at(-1).status, "complete");
  // 桌面客户端的桥接还不认它,这时要给出常驻 worker 的说法,而不是一句「不支持」
  await assert.rejects(
    execFileAsync(process.execPath, [relayClient, "background"], { env: workerEnv }),
    /relay -- worker/
  );
});

test("Codex Mac hooks mark busy, create a placeholder and fill the final reply", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Hook Group", email: "owner@example.com", displayName: "Owner" })
  });
  const configFile = path.join(dataDir, "hook-session.json");
  const bindingsFile = path.join(dataDir, "codex-bindings.json");
  const hookState = path.join(dataDir, "hook-state");
  const threadId = "019fadf2-1111-7777-9999-e224a29edfe9";
  const clientEnv = {
    ...process.env,
    CODEX_THREAD_ID: threadId,
    GROUP_RELAY_AGENT_CONFIG: configFile,
    GROUP_RELAY_CODEX_BINDINGS: bindingsFile
  };

  const joined = await execFileAsync(process.execPath, [
    relayClient,
    "join",
    created.body.inviteUrl.replace("http://relay.test", base),
    "--provider",
    "codex",
    "--owner",
    "Yunfei",
    "--email",
    "yunfei@example.com",
    "--name",
    "Codex",
    "--hook-placeholder"
  ], { env: clientEnv });
  assert.equal(JSON.parse(joined.stdout).codexBinding.threadId, threadId);

  const hookEnv = {
    ...process.env,
    GROUP_RELAY_CODEX_BINDINGS: bindingsFile,
    GROUP_RELAY_CODEX_HOOK_STATE: hookState
  };
  await execFileWithInput(process.execPath, [codexHook], JSON.stringify({
      session_id: threadId,
      turn_id: "turn-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "请处理群消息"
    }), { env: hookEnv });

  let groupState = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  const ai = groupState.body.members.find((member) => member.type === "ai");
  assert.equal(ai.presence.status, "busy");

  let history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  const placeholder = history.body.messages.at(-1);
  assert.equal(placeholder.status, "processing");

  await execFileWithInput(process.execPath, [codexHook], JSON.stringify({
      session_id: threadId,
      turn_id: "turn-1",
      hook_event_name: "Stop",
      last_assistant_message: "Hook 已回填最终答案"
    }), { env: hookEnv });
  history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.at(-1).id, placeholder.id);
  assert.equal(history.body.messages.at(-1).text, "Hook 已回填最终答案");
  assert.equal(history.body.messages.at(-1).status, "complete");
  groupState = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(groupState.body.members.find((member) => member.id === ai.id).presence.status, "online");
});

test("Codex hook installer merges existing hooks without replacing them", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "group-relay-codex-home-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await fs.writeFile(path.join(codexHome, "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "node existing-hook.js" }] }]
    }
  }));
  await execFileAsync(process.execPath, [codexHookInstaller], {
    env: { ...process.env, CODEX_HOME: codexHome }
  });
  await execFileAsync(process.execPath, [codexHookInstaller], {
    env: { ...process.env, CODEX_HOME: codexHome }
  });
  const installed = JSON.parse(await fs.readFile(path.join(codexHome, "hooks.json"), "utf8"));
  assert.equal(installed.hooks.Stop.filter((entry) => (
    entry.hooks.some((hook) => hook.command.includes("/bin/codex-hook.js"))
  )).length, 1);
  assert.equal(installed.hooks.Stop.some((entry) => (
    entry.hooks.some((hook) => hook.command === "node existing-hook.js")
  )), true);
});

test("AI sessions can register and disable the Mac background bridge", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Background Group", email: "owner@example.com", displayName: "Owner" })
  });
  const configFile = path.join(dataDir, "background-session.json");
  const workersFile = path.join(dataDir, "local-workers.json");
  const clientEnv = {
    ...process.env,
    GROUP_RELAY_AGENT_CONFIG: configFile,
    GROUP_RELAY_LOCAL_WORKERS: workersFile
  };
  await execFileAsync(process.execPath, [
    relayClient,
    "join",
    created.body.inviteUrl.replace("http://relay.test", base),
    "--session",
    "mac-background-codex",
    "--provider",
    "codex",
    "--owner",
    "Yunfei",
    "--email",
    "yunfei@example.com",
    "--name",
    "Codex",
    "--background"
  ], { env: clientEnv });
  let registry = JSON.parse(await fs.readFile(workersFile, "utf8"));
  assert.equal(registry.workers["mac-background-codex"].configFile, configFile);
  assert.equal(registry.workers["mac-background-codex"].provider, "codex");

  await execFileAsync(process.execPath, [
    relayClient,
    "background",
    "--session",
    "mac-background-codex",
    "--disable"
  ], { env: clientEnv });
  registry = JSON.parse(await fs.readFile(workersFile, "utf8"));
  assert.equal(registry.workers["mac-background-codex"], undefined);
});

test("MCP send rejects a mismatched expected group ID", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Guarded Group", email: "owner@example.com", displayName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      email: "yunfei@example.com",
      name: "Codex",
      type: "ai",
      provider: "codex",
    })
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServer],
    env: {
      ...process.env,
      GROUP_RELAY_URL: base,
      GROUP_RELAY_GROUP_ID: created.body.group.id,
      GROUP_RELAY_EMAIL: joined.body.member.email,
      GROUP_RELAY_PROVIDER: joined.body.member.provider
    }
  });
  const client = new Client({ name: "group-relay-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const refused = await client.callTool({
    name: "group_send",
    arguments: {
      text: "must not be delivered",
      expectedGroupId: "00000000-0000-4000-8000-000000000000"
    }
  });
  assert.equal(refused.isError, true);

  /// 读也一样。原来 group_history 直接用连接里绑的群,于是 AI 在 A 群被 @、顺手翻的是 B 群,
  /// 拿 B 群的历史回答了 A 群的问题(实测出现过的串群)。现在必须显式说明「我以为我在哪个群」。
  const readOther = await client.callTool({
    name: "group_history",
    arguments: { expectedGroupId: "00000000-0000-4000-8000-000000000000", limit: 10 }
  });
  assert.equal(readOther.isError, true);
  assert.match(JSON.stringify(readOther.content), /Refusing to act/);
  const readBlind = await client.callTool({ name: "group_history", arguments: { limit: 10 } });
  assert.equal(readBlind.isError, true);
  const readMembers = await client.callTool({ name: "group_members", arguments: {} });
  assert.equal(readMembers.isError, true);
  const readRight = await client.callTool({
    name: "group_history",
    arguments: { expectedGroupId: created.body.group.id, limit: 10 }
  });
  assert.equal(readRight.isError ?? false, false);
  assert.equal(JSON.parse(readRight.content[0].text).group.id, created.body.group.id);

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.length, 0);
});

test("group_send_file delivers a generated attachment humans can download", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Deliverables", email: "yunfei@example.com", displayName: "Yunfei" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com", name: "Claude", type: "ai", provider: "claude" })
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServer],
    env: {
      ...process.env,
      GROUP_RELAY_URL: base,
      GROUP_RELAY_GROUP_ID: created.body.group.id,
      GROUP_RELAY_EMAIL: joined.body.member.email,
      GROUP_RELAY_PROVIDER: joined.body.member.provider
    }
  });
  const client = new Client({ name: "group-relay-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const report = "# Weekly report\n\nAll green.";
  const sent = await client.callTool({
    name: "group_send_file",
    arguments: {
      expectedGroupId: created.body.group.id,
      content: report,
      filename: "report.md",
      text: "这是本周报告"
    }
  });
  assert.notEqual(sent.isError, true);

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.length, 1);
  const [message] = history.body.messages;
  assert.equal(message.text, "这是本周报告");
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].name, "report.md");
  assert.equal(message.attachments[0].mimeType, "text/markdown");

  const download = await fetch(`${base}${message.attachments[0].url}`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await download.text(), report);

  // 拒绝空内容且缺少来源的调用,避免发出无意义的空附件。
  const empty = await client.callTool({
    name: "group_send_file",
    arguments: { expectedGroupId: created.body.group.id }
  });
  assert.equal(empty.isError, true);
});

test("attachment downloads force non-images to download and keep images inline", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Disposition", email: "owner@example.com", displayName: "Owner" })
  });
  const headers = { ...asMember(created.body.member.email, created.body.member.provider) };
  const form = new FormData();
  form.set("files", new Blob(["<h1>hi</h1>"], { type: "text/html" }), "page.html");
  form.append("files", new Blob(["PNGDATA"], { type: "image/png" }), "shot.png");
  // SVG 是可以带脚本的文档,不能因为「算图片」就内联
  form.append("files", new Blob(["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"], { type: "image/svg+xml" }), "evil.svg");
  const posted = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers,
    body: form
  });
  assert.equal(posted.status, 201);
  const { message } = await posted.json();
  const byName = Object.fromEntries(message.attachments.map((file) => [file.name, file]));

  const html = await fetch(`${base}${byName["page.html"].url}`, { headers });
  assert.match(html.headers.get("content-disposition"), /^attachment;/);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");

  const png = await fetch(`${base}${byName["shot.png"].url}`, { headers });
  assert.match(png.headers.get("content-disposition"), /^inline;/);

  const svg = await fetch(`${base}${byName["evil.svg"].url}`, { headers });
  assert.match(svg.headers.get("content-disposition"), /^attachment;/);
  assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
});

test("one AI session switches groups and disconnects its previous membership", async (t) => {
  const { base, dataDir } = await fixture(t);
  const first = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "First Group", email: "first.owner@example.com", displayName: "First Owner" })
  });
  const second = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Second Group", email: "second.owner@example.com", displayName: "Second Owner" })
  });
  const configFile = path.join(dataDir, "session-config.json");
  const clientEnv = { ...process.env, GROUP_RELAY_AGENT_CONFIG: configFile };
  const common = [
    "--session",
    "codex-task-123",
    "--provider",
    "codex",
    "--owner",
    "Yunfei",
    "--email",
    "yunfei@example.com",
    "--name",
    "Codex"
  ];

  await execFileAsync(process.execPath, [
    relayClient,
    "join",
    first.body.inviteUrl.replace("http://relay.test", base),
    ...common
  ], { env: clientEnv });
  const switched = await execFileAsync(process.execPath, [
    relayClient,
    "join",
    second.body.inviteUrl.replace("http://relay.test", base),
    ...common
  ], { env: clientEnv });
  const switchedBody = JSON.parse(switched.stdout);
  assert.equal(switchedBody.disconnectedPrevious, true);
  assert.equal(switchedBody.sessionId, "codex-task-123");
  assert.equal(switchedBody.group.id, second.body.group.id);

  const firstState = await json(base, `/api/groups/${first.body.group.id}`, {
    headers: { ...asMember(first.body.member.email, first.body.member.provider) }
  });
  assert.equal(firstState.body.members.some((member) => member.type === "ai"), false);

  const secondState = await json(base, `/api/groups/${second.body.group.id}`, {
    headers: { ...asMember(second.body.member.email, second.body.member.provider) }
  });
  assert.equal(secondState.body.members.filter((member) => member.type === "ai").length, 1);

  const otherSessionEnv = {
    ...process.env,
    GROUP_RELAY_AGENT_CONFIG: path.join(dataDir, "other-session-config.json")
  };
  await execFileAsync(process.execPath, [
    relayClient,
    "join",
    first.body.inviteUrl.replace("http://relay.test", base),
    "--session",
    "codex-task-456",
    "--provider",
    "codex",
    "--owner",
    "Zoe",
    "--email",
    "zoe@example.com",
    "--name",
    "Codex"
  ], { env: otherSessionEnv });

  const firstWithOtherSession = await json(base, `/api/groups/${first.body.group.id}`, {
    headers: { ...asMember(first.body.member.email, first.body.member.provider) }
  });
  assert.equal(firstWithOtherSession.body.members.filter((member) => member.type === "ai").length, 1);
  const secondStillConnected = await json(base, `/api/groups/${second.body.group.id}`, {
    headers: { ...asMember(second.body.member.email, second.body.member.provider) }
  });
  assert.equal(secondStillConnected.body.members.filter((member) => member.type === "ai").length, 1);
});

test("compresses message logs from previous days and can still read them", async (t) => {
  const { store } = await fixture(t);
  const { group, owner } = await store.createGroup({ name: "Archive", email: "owner@example.com", displayName: "Owner" });
  const oldMessage = {
    id: "old-message",
    groupId: group.id,
    sender: { id: owner.id, name: owner.name, type: "human", provider: null },
    text: "from yesterday",
    attachments: [],
    replyTo: null,
    createdAt: "2026-07-28T10:00:00.000Z"
  };
  const oldFile = path.join(store.groupDir(group.id), "messages", "2026-07-28.jsonl");
  await fs.writeFile(oldFile, `${JSON.stringify(oldMessage)}\n`);
  const count = await store.archiveOldMessages(new Date("2026-07-29T10:00:00.000Z"));
  assert.equal(count, 1);
  await assert.rejects(fs.access(oldFile));
  await fs.access(`${oldFile}.gz`);
  const messages = await store.readMessages(group.id);
  assert.equal(messages[0].text, "from yesterday");
});

test("reads recent messages without decompressing the whole history", async (t) => {
  const { store } = await fixture(t);
  const { group, owner } = await store.createGroup({ name: "Tail", email: "owner@example.com", displayName: "Owner" });
  const dir = path.join(store.groupDir(group.id), "messages");
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  for (const day of days) {
    const lines = [0, 1, 2].map((index) => JSON.stringify({
      id: `${day}-${index}`,
      groupId: group.id,
      sender: { id: owner.id, name: owner.name, type: "human", provider: null },
      text: `${day} #${index}`,
      attachments: [],
      replyTo: null,
      createdAt: `${day}T10:00:0${index}.000Z`
    }));
    await fs.writeFile(path.join(dir, `${day}.jsonl`), `${lines.join("\n")}\n`);
  }
  const reads = [];
  const readFile = store.readMessageFile.bind(store);
  store.readMessageFile = async (file) => {
    reads.push(path.basename(file));
    return readFile(file);
  };

  const latest = await store.readMessages(group.id, { limit: 2 });
  assert.deepEqual(latest.map((message) => message.id), ["2026-08-03-1", "2026-08-03-2"]);
  assert.deepEqual(reads, ["2026-08-03.jsonl"]);

  reads.length = 0;
  const afterOlderCursor = await store.readMessages(group.id, { after: "2026-08-02-1", limit: 100 });
  assert.deepEqual(
    afterOlderCursor.map((message) => message.id),
    ["2026-08-02-2", "2026-08-03-0", "2026-08-03-1", "2026-08-03-2"]
  );
  assert.deepEqual(reads, ["2026-08-03.jsonl", "2026-08-02.jsonl"]);

  reads.length = 0;
  const purgedCursor = await store.readMessages(group.id, { after: "purged-away", limit: 2 });
  assert.deepEqual(purgedCursor.map((message) => message.id), ["2026-08-03-1", "2026-08-03-2"]);
  assert.deepEqual(reads, ["2026-08-03.jsonl"]);
});

test("purges expired messages, attachments and finished records", async (t) => {
  const { store } = await fixture(t);
  const { group, owner } = await store.createGroup({ name: "Purge", email: "owner@example.com", displayName: "Owner" });
  const now = new Date("2026-08-10T12:00:00.000Z");
  const groupDir = store.groupDir(group.id);
  const messageLine = (day) => `${JSON.stringify({
    id: day,
    groupId: group.id,
    sender: { id: owner.id, name: owner.name, type: "human", provider: null },
    text: day,
    attachments: [],
    replyTo: null,
    createdAt: `${day}T10:00:00.000Z`
  })}\n`;
  const expiredMessages = path.join(groupDir, "messages", "2026-08-01.jsonl.gz");
  const keptMessages = path.join(groupDir, "messages", "2026-08-08.jsonl.gz");
  await fs.writeFile(expiredMessages, zlib.gzipSync(Buffer.from(messageLine("2026-08-01"))));
  await fs.writeFile(keptMessages, zlib.gzipSync(Buffer.from(messageLine("2026-08-08"))));

  const expiredAttachmentDir = path.join(groupDir, "attachments", "2026-08-07");
  const keptAttachmentDir = path.join(groupDir, "attachments", "2026-08-10");
  await fs.mkdir(expiredAttachmentDir, { recursive: true });
  await fs.mkdir(keptAttachmentDir, { recursive: true });
  const expiredAttachment = path.join(expiredAttachmentDir, "old.png");
  const keptAttachment = path.join(keptAttachmentDir, "fresh.png");
  await fs.writeFile(expiredAttachment, "old");
  await fs.writeFile(keptAttachment, "fresh");
  // 附件按文件 mtime 判定,所以这里是真的「超过 48 小时」而不是按天取整。
  const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);
  await fs.utimes(expiredAttachment, threeDaysAgo, threeDaysAgo);
  await fs.utimes(keptAttachment, now, now);

  await fs.writeFile(path.join(groupDir, "approvals.json"), JSON.stringify([
    { id: "resolved-old", status: "approved", updatedAt: "2026-08-01T10:00:00.000Z", summary: "旧审批" },
    { id: "pending-old", status: "pending", updatedAt: "2026-08-01T10:00:00.000Z", summary: "还没批" }
  ]));
  await fs.writeFile(path.join(groupDir, "tasks.json"), JSON.stringify([
    { id: "done-old", status: "completed", updatedAt: "2026-08-01T10:00:00.000Z" },
    { id: "open-old", status: "assigned", updatedAt: "2026-08-01T10:00:00.000Z" }
  ]));

  const staleUpload = path.join(store.uploadTempDir, "abandoned");
  const freshUpload = path.join(store.uploadTempDir, "in-flight");
  await fs.writeFile(staleUpload, "abandoned");
  await fs.writeFile(freshUpload, "in-flight");
  await fs.utimes(staleUpload, threeDaysAgo, threeDaysAgo);
  await fs.utimes(freshUpload, now, now);

  const purged = await store.purgeExpired({ messageDays: 7, attachmentHours: 48, now });

  assert.deepEqual(purged, {
    messageFiles: 1,
    attachments: 1,
    approvals: 1,
    tasks: 1,
    uploadTemp: 1
  });
  await assert.rejects(fs.access(expiredMessages));
  await fs.access(keptMessages);
  await assert.rejects(fs.access(expiredAttachmentDir));
  await fs.access(keptAttachment);
  await assert.rejects(fs.access(staleUpload));
  await fs.access(freshUpload);
  assert.deepEqual((await store.listApprovals(group.id)).map((item) => item.id), ["pending-old"]);
  assert.deepEqual((await store.listTasks(group.id)).map((item) => item.id), ["open-old"]);
  assert.deepEqual((await store.readMessages(group.id)).map((item) => item.id), ["2026-08-08"]);

  const again = await store.purgeExpired({ messageDays: 7, attachmentHours: 48, now });
  assert.deepEqual(again, { messageFiles: 0, attachments: 0, approvals: 0, tasks: 0, uploadTemp: 0 });
});

test("expired one-time tokens are dropped instead of living in memory forever", async (t) => {
  const { base, sweepExpiredTokens } = await fixture(t);
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "sweep@example.com" })
  });
  const accountEmail = account.body.account.email;
  const transfer = await json(base, "/api/account/browser-transfers", {
    method: "POST",
    headers: { "X-Relay-Email": accountEmail },
    body: "{}"
  });
  const url = `/api/account/browser-transfers/${transfer.body.transferToken}`;
  assert.equal((await json(base, url, { headers: { "X-Relay-Email": accountEmail } })).response.status, 200);

  sweepExpiredTokens(Date.parse(transfer.body.expiresAt) + 60 * 60_000);

  const afterSweep = await json(base, url, { headers: { "X-Relay-Email": accountEmail } });
  assert.equal(afterSweep.response.status, 404);
});

test("migrates legacy token-based data to email-keyed accounts", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-relay-legacy-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const groupId = "11111111-1111-4111-8111-111111111111";
  const ownerMemberId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const guestMemberId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const aiMemberId = "cccccccc-3333-4333-8333-cccccccccccc";
  await fs.mkdir(path.join(dataDir, "groups", groupId, "messages"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "accounts.json"), JSON.stringify({
    "account-1": {
      id: "account-1",
      email: "Owner@Example.com",
      normalizedEmail: "owner@example.com",
      displayName: "Owner",
      avatarDataUrl: null,
      token: "account-token-1",
      createdAt: "2026-08-01T00:00:00.000Z",
      memberships: [{ groupId, memberId: ownerMemberId, memberToken: "owner-member-token" }]
    }
  }));
  await fs.writeFile(path.join(dataDir, "invites.json"), JSON.stringify({ "invite-1": groupId }));
  await fs.writeFile(path.join(dataDir, "groups", groupId, "group.json"), JSON.stringify({
    id: groupId, name: "Legacy group", createdAt: "2026-08-01T00:00:00.000Z",
    inviteToken: "invite-1", ownerMemberId
  }));
  await fs.writeFile(path.join(dataDir, "groups", groupId, "members.json"), JSON.stringify([
    { id: ownerMemberId, name: "Owner", type: "human", provider: null, token: "owner-member-token" },
    { id: guestMemberId, name: "Browser Guest", type: "human", provider: null, token: "guest-member-token" },
    {
      id: aiMemberId, name: "Codex", type: "ai", provider: "codex", ownerName: "Owner",
      token: "ai-member-token", desktopOwnerAccountId: "account-1", joinedAt: "2026-08-02T00:00:00.000Z",
      desktopOwnerMemberId: ownerMemberId, trustedOwnerMemberId: ownerMemberId
    }
  ]));
  await fs.writeFile(path.join(dataDir, "groups", groupId, "messages", "2026-08-01.jsonl"),
    `${JSON.stringify({
      id: "message-1", groupId,
      sender: { id: ownerMemberId, name: "Owner", type: "human", provider: null },
      text: "@Codex 看一下", attachments: [], mentions: [{ id: aiMemberId, name: "Codex" }],
      replyTo: null, createdAt: "2026-08-01T10:00:00.000Z"
    })}\n`);

  const { store, base } = await fixture(t, { dataDir });
  assert.deepEqual(
    { accounts: store.migration.accounts, groups: store.migration.groups },
    // owner + 那个只在浏览器里存过 token 的真人;AI 挂在 owner 名下,不算独立账号
    { accounts: 2, groups: 1 }
  );

  // 群挂在建群人的 email 下,其他真人只留 groupId,AI 变成注册项。
  const accounts = await store.accounts();
  assert.deepEqual(accounts["owner@example.com"].createdGroups.map((group) => group.name), ["Legacy group"]);
  assert.deepEqual(accounts["owner@example.com"].ais, [{
    groupId, provider: "codex", name: "Codex", trusted: true, joinedAt: "2026-08-02T00:00:00.000Z"
  }]);
  const guestEmail = Object.keys(accounts).find((email) => email.startsWith("browser.guest."));
  assert.deepEqual(accounts[guestEmail].joinedGroups, [groupId]);

  // 名册和邀请链接都还在
  assert.equal((await store.groupFromInvite("invite-1")).id, groupId);
  assert.deepEqual(
    (await store.listMembers(groupId)).map((member) => member.id).sort(),
    ["ai:owner@example.com:codex", `human:${guestEmail}`, "human:owner@example.com"].sort()
  );

  // 缓冲区里的旧 uuid 被换成新 id,否则 @mention 全部失配
  const [message] = await store.readMessages(groupId);
  assert.equal(message.sender.id, "human:owner@example.com");
  assert.deepEqual(message.mentions, [{ id: "ai:owner@example.com:codex", name: "Codex" }]);

  // 旧客户端手里只有 token:一次性换回 email
  const legacy = await json(base, `/api/groups/${groupId}`, {
    headers: { Authorization: "Bearer owner-member-token" }
  });
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.body.group.name, "Legacy group");
  const legacyAccount = await json(base, "/api/account", {
    headers: { "X-Account-Token": "account-token-1" }
  });
  assert.equal(legacyAccount.body.account.email, "owner@example.com");

  // 幂等:再跑一次不做任何事
  const { migrateLegacyData } = await import("../src/migrate-legacy.js");
  assert.equal(await migrateLegacyData(dataDir), null);
});

test("account data syncs to another server, keeping group ids and invite links", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);

  const created = await json(source.base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Moving day", email: "mover@example.com", displayName: "Mover" })
  });
  const groupId = created.body.group.id;
  const inviteToken = created.body.group.inviteToken;
  await json(source.base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: { "X-Relay-Email": "mover@example.com" },
    body: JSON.stringify({ provider: "codex" })
  });

  const synced = await json(source.base, "/api/account/sync", {
    method: "POST",
    headers: { "X-Relay-Email": "mover@example.com" },
    body: JSON.stringify({ targetBaseUrl: target.base })
  });
  assert.equal(synced.response.status, 200);
  assert.deepEqual(synced.body.synced, {
    email: "mover@example.com", createdGroups: 1, joinedGroups: 0, ais: 1
  });
  assert.equal(synced.body.applied.groups, 1);

  // 群 id 和邀请 token 必须原样落在新服务器上:客户端本地记录和已发出的邀请链接都按它们认群。
  const onTarget = await json(target.base, `/api/groups/${groupId}`, {
    headers: { "X-Relay-Email": "mover@example.com" }
  });
  assert.equal(onTarget.response.status, 200);
  assert.equal(onTarget.body.group.name, "Moving day");
  assert.equal(onTarget.body.group.inviteToken, inviteToken);
  assert.deepEqual(
    onTarget.body.members.map((member) => member.id).sort(),
    ["ai:mover@example.com:codex", "human:mover@example.com"]
  );
  const invite = await json(target.base, `/api/invites/${inviteToken}`);
  assert.equal(invite.body.group.id, groupId);

  // 新服务器上立刻能发消息(群目录已经建好),而聊天记录不在同步内容里
  const message = new FormData();
  message.set("text", "在新服务器上发的第一条");
  const sent = await fetch(`${target.base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: { "X-Relay-Email": "mover@example.com" },
    body: message
  });
  assert.equal(sent.status, 201);
  assert.equal((await target.store.readMessages(groupId)).length, 1);
  assert.equal((await source.store.readMessages(groupId)).length, 0);

  // 幂等:再同步一次不重复建群
  const again = await json(source.base, "/api/account/sync", {
    method: "POST",
    headers: { "X-Relay-Email": "mover@example.com" },
    body: JSON.stringify({ targetBaseUrl: target.base })
  });
  assert.equal(again.body.applied.groups, 0);
  assert.equal((await target.store.accounts())["mover@example.com"].createdGroups.length, 1);

  const refused = await json(source.base, "/api/account/sync", {
    method: "POST",
    headers: { "X-Relay-Email": "mover@example.com" },
    body: JSON.stringify({ targetBaseUrl: "ftp://example.com" })
  });
  assert.equal(refused.response.status, 400);
});

test("refuses to sync to a server that is still on the old protocol", async (t) => {
  const { base } = await fixture(t);
  await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Old target", email: "owner@example.com", displayName: "Owner" })
  });

  // 旧版本的 /health 只回 {ok:true},没有 identity 字段。
  const legacy = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ ok: true }));
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => legacy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => legacy.close(resolve)));

  const refused = await json(base, "/api/account/sync", {
    method: "POST",
    headers: { "X-Relay-Email": "owner@example.com" },
    body: JSON.stringify({ targetBaseUrl: `http://127.0.0.1:${legacy.address().port}` })
  });
  assert.equal(refused.response.status, 409);
  assert.match(refused.body.error, /旧协议/);

  const unreachable = await json(base, "/api/account/sync", {
    method: "POST",
    headers: { "X-Relay-Email": "owner@example.com" },
    body: JSON.stringify({ targetBaseUrl: "http://127.0.0.1:1" })
  });
  assert.equal(unreachable.response.status, 409);
  assert.match(unreachable.body.error, /无法访问/);
});

test("a whole server migrates itself, so nobody has to press anything", async (t) => {
  const target = await fixture(t);
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-relay-moving-"));
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const source = await fixture(t, { dataDir: sourceDir });

  const created = await json(source.base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Whole server", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  for (const [email, name] of [["member@example.com", "Member"], ["zoe@example.com", "Zoe"]]) {
    await json(source.base, `/api/invites/${created.body.group.inviteToken}/join`, {
      method: "POST",
      body: JSON.stringify({ email, name, type: "human" })
    });
  }
  await json(source.base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: { "X-Relay-Email": "owner@example.com" },
    body: JSON.stringify({ provider: "codex" })
  });

  // 部署方设置搬迁地址后重启老服务器,它把所有账号推过去。
  const moving = await fixture(t, { dataDir: sourceDir, movedTo: target.base });
  const result = await moving.pushEverythingToNewServer();
  assert.equal(result.migrated, 3);
  assert.deepEqual(result.failed, []);

  // 三个人谁都没点过按钮,群主是否先同步也不再重要。
  for (const email of ["owner@example.com", "member@example.com", "zoe@example.com"]) {
    const sessions = await json(target.base, "/api/account/sessions", {
      headers: { "X-Relay-Email": email }
    });
    assert.equal(sessions.body.sessions.length, 1, email);
    assert.equal(sessions.body.sessions[0].group.id, groupId);
  }
  const roster = await json(target.base, `/api/groups/${groupId}`, {
    headers: { "X-Relay-Email": "owner@example.com" }
  });
  assert.deepEqual(
    roster.body.members.map((member) => `${member.type}:${member.name}`).sort(),
    ["ai:Codex", "human:Member", "human:Owner", "human:Zoe"]
  );
  assert.equal(roster.body.group.inviteToken, created.body.group.inviteToken);

  // 老服务器公告新地址,客户端据此自己跟随;并且不能有写接口能改它。
  const health = await json(moving.base, "/health");
  assert.equal(health.body.movedTo, target.base);
  assert.equal((await json(target.base, "/health")).body.movedTo, undefined);

  // 聊天记录不随服务器走
  assert.equal((await target.store.readMessages(groupId)).length, 0);
});

test("an old device identity binds an email and takes its groups with it", async (t) => {
  const { base, store } = await fixture(t);
  // 这个人一直用浏览器的本机账号:群、AI 和消息都挂在设备身份下。
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({
      name: "设备身份建的群",
      email: "device-abc@device.group-relay.example.com",
      displayName: "yunfei.cao"
    })
  });
  const groupId = created.body.group.id;
  const deviceEmail = "device-abc@device.group-relay.example.com";
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: { "X-Relay-Email": deviceEmail },
    body: JSON.stringify({ provider: "codex" })
  });
  const message = new FormData();
  message.set("text", "@Codex 老消息");
  message.set("mentions", JSON.stringify([`ai:${deviceEmail}:codex`]));
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: { "X-Relay-Email": deviceEmail },
    body: message
  });

  const claimed = await json(base, "/api/account/claim", {
    method: "POST",
    headers: { "X-Relay-Email": deviceEmail },
    body: JSON.stringify({ email: "yunfei@example.com" })
  });
  assert.equal(claimed.response.status, 200);
  assert.deepEqual(
    { groups: claimed.body.groups, ais: claimed.body.ais },
    { groups: 1, ais: 1 }
  );

  // 群跟着邮箱走了
  const sessions = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "yunfei@example.com" }
  });
  assert.deepEqual(sessions.body.sessions.map((s) => s.group.name), ["设备身份建的群"]);
  assert.deepEqual(
    (await store.listMembers(groupId)).map((member) => member.id).sort(),
    ["ai:yunfei@example.com:codex", "human:yunfei@example.com"]
  );

  // 缓冲区里的发言人和 @ 对象一起改写,否则旧消息的 mention 全部失配
  const [buffered] = await store.readMessages(groupId);
  assert.equal(buffered.sender.id, "human:yunfei@example.com");
  assert.deepEqual(buffered.mentions.map((m) => m.id), ["ai:yunfei@example.com:codex"]);

  // 群里的人认的是设备身份那个昵称,继承过来(目标账号从没设过昵称时)
  assert.equal((await store.accountByEmail("yunfei@example.com")).displayName, "yunfei.cao");

  // claim 之前已经以成员身份加入过的群,不能在列表里出现两次
  const twice = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "yunfei@example.com" }
  });
  assert.equal(twice.body.sessions.filter((s) => s.group.id === groupId).length, 1);

  // 设备身份变成空壳,还拿着它的客户端不会 404
  const leftover = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": deviceEmail }
  });
  assert.equal(leftover.response.status, 200);
  assert.deepEqual(leftover.body.sessions, []);
});

test("the owner deletes a group while a member only leaves it", async (t) => {
  const { base, store } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "退与删", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "member@example.com", name: "Member", type: "human" })
  });
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: { "X-Relay-Email": "member@example.com" },
    body: JSON.stringify({ provider: "codex" })
  });

  // 列表要告诉客户端自己是不是群主,按钮才知道该删还是该退
  const ownerList = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "owner@example.com" }
  });
  assert.equal(ownerList.body.sessions[0].isOwner, true);
  const memberList = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "member@example.com" }
  });
  assert.equal(memberList.body.sessions[0].isOwner, false);

  // 成员删不掉群
  const refused = await json(base, `/api/groups/${groupId}`, {
    method: "DELETE",
    headers: { "X-Relay-Email": "member@example.com" }
  });
  assert.equal(refused.response.status, 403);

  // 成员退群:自己和自己的 AI 走,群还在
  await json(base, `/api/account/sessions/${groupId}`, {
    method: "DELETE",
    headers: { "X-Relay-Email": "member@example.com" }
  });
  assert.deepEqual(
    (await store.listMembers(groupId)).map((member) => member.id),
    ["human:owner@example.com"]
  );
  assert.ok(await store.getGroup(groupId));

  // 群主删群:群没了,群主列表也空了
  const deleted = await json(base, `/api/groups/${groupId}`, {
    method: "DELETE",
    headers: { "X-Relay-Email": "owner@example.com" }
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(await store.getGroup(groupId), null);
  const after = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "owner@example.com" }
  });
  assert.deepEqual(after.body.sessions, []);
});

test("one invite link serves a browser and an AI differently", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "自主接入", email: "owner@example.com", displayName: "Owner" })
  });
  const token = created.body.group.inviteToken;
  const groupId = created.body.group.id;

  // 浏览器:Accept 里有 text/html,拿到网页
  const asBrowser = await fetch(`${base}/join/${token}`, { headers: { Accept: "text/html" } });
  assert.equal(asBrowser.headers.get("content-type")?.includes("text/html"), true);
  assert.match(await asBrowser.text(), /<title>Group Relay<\/title>/);

  // AI:curl 那种 */*,拿到纯文本接入说明,身份从链接参数填进去
  const asAgent = await fetch(
    `${base}/join/${token}?owner=${encodeURIComponent("Owner")}&email=${encodeURIComponent("owner@example.com")}`,
    { headers: { Accept: "*/*" } }
  );
  assert.equal(asAgent.headers.get("content-type")?.includes("text/plain"), true);
  const sheet = await asAgent.text();
  assert.match(sheet, /npm run relay -- join/);
  assert.match(sheet, /--email "owner@example\.com"/);
  assert.match(sheet, /--owner "Owner"/);
  assert.ok(sheet.includes(groupId), "说明里要有群组 id 供 AI 自查");
  assert.match(sheet, /GROUP_RELAY_APPROVAL_REQUIRED/);

  // 没带身份时要让 AI 去问,而不是编一个
  const bare = await fetch(`${base}/join/${token}`, { headers: { Accept: "*/*" } });
  assert.match(await bare.text(), /问一下把你叫来的人/);

  // 失效的邀请对 AI 也要说清楚,而不是回一个网页
  const dead = await fetch(`${base}/join/nope-not-a-token`, { headers: { Accept: "*/*" } });
  assert.equal(dead.status, 404);
  assert.match(await dead.text(), /已失效/);

  // ?format= 可以强制,便于人工排查
  const forced = await fetch(`${base}/join/${token}?format=text`, { headers: { Accept: "text/html" } });
  assert.match(await forced.text(), /AI 接入说明/);
});

test("a Chinese attachment name survives the upload", async (t) => {
  const { base, store } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "附件名", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const form = new FormData();
  form.set("text", "158 条的中文名+业务逻辑表");
  form.set("files", new Blob(["col\n"], { type: "text/csv" }), "特征中文名与业务逻辑158条.xlsx");
  const sent = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: { "X-Relay-Email": "owner@example.com" },
    body: form
  });
  assert.equal(sent.status, 201);

  // multipart 头是按 latin1 解出来的,不还原就会存成 ç¹å¾…æ¡.xlsx
  const [message] = await store.readMessages(groupId);
  assert.equal(message.attachments[0].name, "特征中文名与业务逻辑158条.xlsx");

  // 存到磁盘上的文件名同样是可读的中文,并且能按 URL 取回来
  const download = await fetch(`${base}${message.attachments[0].url}`, {
    headers: { "X-Relay-Email": "owner@example.com" }
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "col\n");

  // 纯 ASCII 名字不能被这套还原逻辑改坏
  const ascii = new FormData();
  ascii.set("text", "ascii");
  ascii.set("files", new Blob(["x"], { type: "text/plain" }), "report_v2.final.txt");
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: { "X-Relay-Email": "owner@example.com" },
    body: ascii
  });
  const all = await store.readMessages(groupId);
  assert.equal(all.at(-1).attachments[0].name, "report_v2.final.txt");
});

test("an invite link's identity params never speak for whoever opens it", async (t) => {
  const { base, store } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "转发的邀请", email: "zoe@example.com", displayName: "Zoe" })
  });
  const token = created.body.group.inviteToken;
  const groupId = created.body.group.id;

  // AI 读的说明里必须有身份,这是参数存在的理由
  const sheet = await (await fetch(
    `${base}/join/${token}?owner=Zoe&email=zoe%40example.com`, { headers: { Accept: "*/*" } }
  )).text();
  assert.match(sheet, /--email "zoe@example\.com"/);

  // 同事收到同一条链接后自己填邮箱加入,必须是独立身份,而不是变成 Zoe
  const joined = await json(base, `/api/invites/${token}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "yizhen@example.com", name: "Yizhen", type: "human" })
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.member.id, "human:yizhen@example.com");

  const members = await store.listMembers(groupId);
  assert.deepEqual(
    members.map((member) => `${member.name}(${member.id})`).sort(),
    ["Yizhen(human:yizhen@example.com)", "Zoe(human:zoe@example.com)"]
  );
  // Zoe 的昵称不能被后来者改掉
  assert.equal((await store.accountByEmail("zoe@example.com")).displayName, "Zoe");
});

test("an AI can still fill in its placeholder after the day file was compressed", async (t) => {
  const { base, store } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "跨天回写", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: { "X-Relay-Email": "owner@example.com" },
    body: JSON.stringify({ provider: "claude" })
  });
  const aiHeaders = { "X-Relay-Email": "owner@example.com", "X-Relay-Provider": "claude" };

  const placeholder = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: aiHeaders,
    body: new URLSearchParams({ text: "正在处理这个问题，请稍等…", status: "processing" })
  }).then((response) => response.json());

  // 把它挪到昨天再跑归档,复现「任务跨过一次每小时归档」
  const messagesDir = path.join(store.groupDir(groupId), "messages");
  const [today] = await fs.readdir(messagesDir);
  await fs.rename(path.join(messagesDir, today), path.join(messagesDir, "2026-08-10.jsonl"));
  assert.equal(await store.archiveOldMessages(new Date("2026-08-11T00:30:00Z")), 1);
  assert.deepEqual(await fs.readdir(messagesDir), ["2026-08-10.jsonl.gz"]);

  // 压缩过也要能回写,否则泡泡永远停在「正在处理」,答案只能另发一条
  const filled = await json(base, `/api/groups/${groupId}/messages/${placeholder.message.id}`, {
    method: "PATCH",
    headers: aiHeaders,
    body: JSON.stringify({ text: "这是我的答案", status: "complete" })
  });
  assert.equal(filled.response.status, 200);
  const [message] = await store.readMessages(groupId);
  assert.equal(message.text, "这是我的答案");
  assert.equal(message.status, "complete");
  // 文件还是压缩的,不能因为改了一次就退回未压缩
  assert.deepEqual(await fs.readdir(messagesDir), ["2026-08-10.jsonl.gz"]);

  // 重连时把中断的占位标记为失败,同样要能改到压缩文件
  const stuck = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: aiHeaders,
    body: new URLSearchParams({ text: "又在处理…", status: "processing" })
  }).then((response) => response.json());
  const dir2 = await fs.readdir(messagesDir);
  const plain = dir2.find((name) => name.endsWith(".jsonl"));
  await fs.rename(path.join(messagesDir, plain), path.join(messagesDir, "2026-08-10b.jsonl"));
  await fs.rename(path.join(messagesDir, "2026-08-10b.jsonl"), path.join(messagesDir, "2026-08-09.jsonl"));
  await store.archiveOldMessages(new Date("2026-08-11T00:30:00Z"));
  const failed = await store.failProcessingMessages(groupId, `ai:owner@example.com:claude`, "桥接重启，已中止");
  assert.equal(failed.filter((message) => message.id === stuck.message.id).length, 1);
});

test("an edit that landed while the client was away comes back on the next open", async (t) => {
  const { base, store } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "补编辑", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ provider: "claude" })
  });
  const aiHeaders = { ...owner, "X-Relay-Provider": "claude" };

  const placeholder = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: aiHeaders,
    body: new URLSearchParams({ text: "正在处理这个问题，请稍等…", status: "processing" })
  }).then((response) => response.json());

  // 占位消息在更早的一天,而且已经被归档压缩:改动只会落回那个文件,不会变成新消息。
  const messagesDir = path.join(store.groupDir(groupId), "messages");
  const [firstDay] = await fs.readdir(messagesDir);
  await fs.rename(path.join(messagesDir, firstDay), path.join(messagesDir, "2026-08-10.jsonl"));
  await store.archiveOldMessages(new Date("2026-08-11T00:30:00Z"));

  // 之后又有新消息,所以客户端本地的最后一条比占位那条新 —— after=<它> 追不回编辑。
  const later = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: owner,
    body: new URLSearchParams({ text: "顺便再问一句" })
  }).then((response) => response.json());

  const away = new Date(Date.now() - 1_000).toISOString();
  const filled = await json(base, `/api/groups/${groupId}/messages/${placeholder.message.id}`, {
    method: "PATCH",
    headers: aiHeaders,
    body: JSON.stringify({ text: "这是我的答案", status: "complete" })
  });
  assert.equal(filled.response.status, 200);

  // 断线期间错过 message_updated 的客户端:只带游标什么都拿不到,这就是气泡永远卡住的原因。
  const cursorOnly = await json(
    base,
    `/api/groups/${groupId}/messages?after=${later.message.id}`,
    { headers: owner }
  );
  assert.deepEqual(cursorOnly.body.messages, []);
  assert.ok(cursorOnly.body.syncedAt, "响应要带 syncedAt,客户端下次拿它当 updatedSince");

  // B:按修改时间追赶,压缩过的那天也要能捞出来。
  const byTime = await json(
    base,
    `/api/groups/${groupId}/messages?after=${later.message.id}&updatedSince=${encodeURIComponent(away)}`,
    { headers: owner }
  );
  assert.deepEqual(byTime.body.messages.map((message) => message.id), [placeholder.message.id]);
  assert.equal(byTime.body.messages[0].text, "这是我的答案");
  assert.equal(byTime.body.messages[0].status, "complete");
  // 游标不能被补回来的旧消息带着往回走,否则下一轮长轮询会把它之后的全部重发一遍。
  assert.equal(byTime.body.cursor, later.message.id);

  // A:没有 updatedSince(比如刚升级、本地还没记过同步点)时,按 id 点名要那几条未终态的。
  const byId = await json(
    base,
    `/api/groups/${groupId}/messages?after=${later.message.id}&ids=${placeholder.message.id}`,
    { headers: owner }
  );
  assert.deepEqual(byId.body.messages.map((message) => message.id), [placeholder.message.id]);
  assert.equal(byId.body.messages[0].text, "这是我的答案");

  // 不认识的 id 和垃圾参数都只是拿不到东西,不能报错。
  const nonsense = await json(
    base,
    `/api/groups/${groupId}/messages?after=${later.message.id}&ids=not-a-uuid,${crypto.randomUUID()}&updatedSince=昨天`,
    { headers: owner }
  );
  assert.equal(nonsense.response.status, 200);
  assert.deepEqual(nonsense.body.messages, []);

  // AI 是按 routed 拉待办的,把改过的旧消息补给它等于让它把活重做一遍。
  const routed = await json(
    base,
    `/api/groups/${groupId}/messages?routed=1&updatedSince=${encodeURIComponent(away)}&ids=${placeholder.message.id}`,
    { headers: aiHeaders }
  );
  assert.equal(
    routed.body.messages.some((message) => message.id === placeholder.message.id),
    false
  );
});

test("feedback tickets are only accepted from an AI, and only people can triage them", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "反馈", email: "owner@example.com", displayName: "Yunfei" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ provider: "claude" })
  });
  const ai = { ...owner, "X-Relay-Provider": "claude" };

  // 人自己提要被挡住,并且要被告诉去找自己的 AI —— 一句原话没法直接开工
  const byHuman = await json(base, "/api/feedback", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ title: "这里不好用", body: "反正就是不好用" })
  });
  assert.equal(byHuman.response.status, 403);
  assert.match(byHuman.body.error, /AI/);

  const byAi = await json(base, "/api/feedback", {
    method: "POST",
    headers: ai,
    body: JSON.stringify({
      title: "开群时应当先显示本机记录",
      body: "现象：打开群组要等两个接口回来才出现内容。\n期望：本机已有副本时先渲染，再用服务端结果对齐。",
      onBehalfOf: "Zoe",
      groupId
    })
  });
  assert.equal(byAi.response.status, 201);
  assert.equal(byAi.body.ticket.status, "open");
  assert.equal(byAi.body.ticket.author.id, "ai:owner@example.com:claude");
  assert.equal(byAi.body.ticket.author.ownerName, "Yunfei");
  assert.equal(byAi.body.ticket.onBehalfOf, "Zoe");

  const listed = await json(base, "/api/feedback", { headers: owner });
  assert.equal(listed.body.tickets.length, 1);
  assert.equal(listed.body.counts.open, 1);

  // 定级和关单反过来只有人能做
  const aiTriage = await json(base, `/api/feedback/${byAi.body.ticket.id}`, {
    method: "PATCH",
    headers: ai,
    body: JSON.stringify({ status: "done" })
  });
  assert.equal(aiTriage.response.status, 403);

  const triaged = await json(base, `/api/feedback/${byAi.body.ticket.id}`, {
    method: "PATCH",
    headers: owner,
    body: JSON.stringify({ status: "done", note: "已上线" })
  });
  assert.equal(triaged.response.status, 200);
  assert.equal(triaged.body.ticket.status, "done");
  assert.deepEqual(triaged.body.ticket.notes.map((note) => [note.by, note.text]), [["Yunfei", "已上线"]]);

  // 工单存在服务器根目录,不在群目录里 —— 它是待办清单,不跟着消息的保留期被回收
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "feedback.json"), "utf8"));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].title, "开群时应当先显示本机记录");
});

test("trusted execution lets the whole group drive the AI, and off means only the owner", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "三档", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ provider: "claude" })
  });
  const aiHeaders = { ...owner, "X-Relay-Provider": "claude" };
  const guest = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "guest@example.com", name: "Guest" })
  });
  const guestHeaders = { "X-Relay-Email": "guest@example.com" };

  const scopesFor = async () => {
    const routed = await json(
      base,
      `/api/groups/${groupId}/messages?routed=1&limit=50`,
      { headers: aiHeaders }
    );
    return Object.fromEntries(routed.body.messages.map((message) => [message.text, message.executionScope]));
  };

  // 自己创建的群里,自己的 AI 默认就是免审批的 —— 先显式关掉,才能验「关着的时候谁都不执行」
  const aiMemberIdForReset = `ai:owner@example.com:claude`;
  await json(base, `/api/groups/${groupId}/members/${aiMemberIdForReset}/trusted-execution`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ enabled: false })
  });
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: owner, body: new URLSearchParams({ text: "主人的第一条" })
  });
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: guestHeaders, body: new URLSearchParams({ text: "客人的第一条" })
  });
  assert.deepEqual(await scopesFor(), { "主人的第一条": "restricted", "客人的第一条": "restricted" });

  const aiMemberId = `ai:owner@example.com:claude`;
  const enabled = await json(base, `/api/groups/${groupId}/members/${aiMemberId}/trusted-execution`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.member.trustedExecutionEnabled, true);

  // 开了之后:主人本人 → 全权;群里其他人 → 只读(能干活,不能改本机)
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: owner, body: new URLSearchParams({ text: "主人的第二条" })
  });
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: guestHeaders, body: new URLSearchParams({ text: "客人的第二条" })
  });
  // 一次轮询里同时看档位和 senderIsOwner:领过的消息不会再重发,不能轮两次。
  const routedNow = await json(base, `/api/groups/${groupId}/messages?routed=1&limit=50`, { headers: aiHeaders });
  const scopes = Object.fromEntries(routedNow.body.messages.map((m) => [m.text, m.executionScope]));
  const ownership = Object.fromEntries(routedNow.body.messages.map((m) => [m.text, m.senderIsOwner]));
  assert.equal(scopes["主人的第二条"], "trusted");
  assert.equal(scopes["客人的第二条"], "trusted");
  assert.equal(ownership["主人的第二条"], true);
  assert.equal(ownership["客人的第二条"], false);
  // 档位是「投递那一刻按当前设置算」,不写死在消息上 —— 上面开、下面关的两轮就是在验这件事。
  // 开关之前的那两条这里已经查不到了:它们在第一次轮询时就被领走,不会再重发。
  assert.equal(scopes["客人的第一条"], undefined);
  assert.equal(guest.body.member.type, "human");

  // 关掉就回到谁都不执行。注意要发新消息来看:同一条 routed 消息只交给先来领的那个 worker,
  // 领过之后不会再重发(这正是重复回复的修法),所以旧消息不能拿来复查档位。
  await json(base, `/api/groups/${groupId}/members/${aiMemberId}/trusted-execution`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ enabled: false })
  });
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: owner, body: new URLSearchParams({ text: "关掉之后主人的" })
  });
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: guestHeaders, body: new URLSearchParams({ text: "关掉之后客人的" })
  });
  const afterOff = await scopesFor();
  assert.equal(afterOff["关掉之后主人的"], "restricted");
  assert.equal(afterOff["关掉之后客人的"], "restricted");
});

test("a routed message goes to the first worker that asks, and a placeholder is not duplicated", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "两个 worker", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
  });
  const ai = { ...owner, "X-Relay-Provider": "claude" };
  const question = (await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: owner,
    body: new URLSearchParams({ text: "@Claude 一个问题", mentions: JSON.stringify(["ai:owner@example.com:claude"]) })
  }).then((response) => response.json())).message;

  // 两个 worker 用的是同一个身份(email+provider),服务端分不出它们 —— 但一条消息只该被领一次
  const first = await json(base, `/api/groups/${groupId}/messages?routed=1&limit=50`, { headers: ai });
  const second = await json(base, `/api/groups/${groupId}/messages?routed=1&limit=50`, { headers: ai });
  assert.equal(first.body.messages.some((message) => message.id === question.id), true);
  assert.equal(second.body.messages.some((message) => message.id === question.id), false);

  // 万一两边都跑到了发占位这一步,也只留一个气泡:第二次拿回的是同一条
  const placeholderA = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: ai,
    body: new URLSearchParams({ text: "正在处理…", status: "processing", replyTo: question.id })
  }).then((response) => response.json());
  const placeholderB = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: ai,
    body: new URLSearchParams({ text: "正在处理…", status: "processing", replyTo: question.id })
  }).then((response) => response.json());
  assert.equal(placeholderB.message.id, placeholderA.message.id);
  assert.equal(placeholderB.deduplicated, true);
  const history = await json(base, `/api/groups/${groupId}/messages`, { headers: owner });
  assert.equal(history.body.messages.filter((message) => message.status === "processing").length, 1);
});

test("switching off a group's desktop worker survives the next client sync", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "开关", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  const other = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "另一个群", email: "owner@example.com", displayName: "Owner" })
  });
  for (const id of [groupId, other.body.group.id]) {
    await json(base, `/api/account/sessions/${id}/ais`, {
      method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
    });
  }
  const memberId = "ai:owner@example.com:claude";
  const before = await json(base, "/api/account/desktop-workers", { headers: owner });
  assert.equal(before.body.workers.length, 2);

  // 群里别人不能替我停掉我机器上的进程
  await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "guest@example.com", name: "Guest" })
  });
  const denied = await json(base, `/api/groups/${groupId}/members/${memberId}/desktop-worker`, {
    method: "POST",
    headers: { "X-Relay-Email": "guest@example.com" },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(denied.response.status, 403);

  const off = await json(base, `/api/groups/${groupId}/members/${memberId}/desktop-worker`, {
    method: "POST", headers: owner, body: JSON.stringify({ enabled: false })
  });
  assert.equal(off.response.status, 200);
  assert.equal(off.body.member.desktopWorkerDisabled, true);

  // 关掉的只是这一个群:客户端下一次(以及以后每一次)同步都拿不到它,所以不会再被拉起来
  for (let round = 0; round < 2; round += 1) {
    const synced = await json(base, "/api/account/desktop-workers", { headers: owner });
    assert.deepEqual(synced.body.workers.map((worker) => worker.groupId), [other.body.group.id]);
  }
  // 关了桌面 worker 不等于把 AI 踢出群 —— 它还在成员里,自己起的命令行 worker 照样能收消息
  const view = await json(base, `/api/groups/${groupId}`, { headers: owner });
  assert.equal(view.body.members.some((member) => member.id === memberId), true);
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST", headers: owner, body: new URLSearchParams({ text: "还能收到吗" })
  });
  const routed = await json(base, `/api/groups/${groupId}/messages?routed=1&limit=10`, {
    headers: { ...owner, "X-Relay-Provider": "claude" }
  });
  assert.equal(routed.body.messages.some((message) => message.text === "还能收到吗"), true);

  const on = await json(base, `/api/groups/${groupId}/members/${memberId}/desktop-worker`, {
    method: "POST", headers: owner, body: JSON.stringify({ enabled: true })
  });
  assert.equal(on.body.member.desktopWorkerDisabled, false);
  const restored = await json(base, "/api/account/desktop-workers", { headers: owner });
  assert.equal(restored.body.workers.length, 2);
});

test("my AI's workload is counted from mentions and survives the message buffer", async (t) => {
  const { base, store, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "工作量", email: "owner@example.com", displayName: "Owner" })
  });
  const groupId = created.body.group.id;
  const owner = { "X-Relay-Email": "owner@example.com" };
  await json(base, `/api/account/sessions/${groupId}/ais`, {
    method: "POST", headers: owner, body: JSON.stringify({ provider: "claude" })
  });
  const aiId = "ai:owner@example.com:claude";
  const ai = { ...owner, "X-Relay-Provider": "claude" };
  await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ email: "guest@example.com", name: "客人" })
  });
  const guest = { "X-Relay-Email": "guest@example.com" };

  const ask = async (headers, text) => (await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ text, mentions: JSON.stringify([aiId]) })
  }).then((response) => response.json())).message;

  // 客人问两次,主人问一次
  const first = await ask(guest, "@Claude 第一个问题");
  const second = await ask(guest, "@Claude 第二个问题");
  const ownerAsk = await ask(owner, "@Claude 主人也问一句");

  // 第一个:先发占位再回写(答案回写进气泡,这是最常见的形态)
  const placeholder = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "正在处理…", status: "processing", replyTo: first.id })
  }).then((response) => response.json());
  await json(base, `/api/groups/${groupId}/messages/${placeholder.message.id}`, {
    method: "PATCH", headers: ai, body: JSON.stringify({ text: "十二个字的答案", status: "complete" })
  });

  // 第二个:直接新发一条带 replyTo 的回复,并且是失败
  await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: ai,
    body: new URLSearchParams({ text: "跑挂了", status: "failed", replyTo: second.id })
  });
  // 主人那条不回答 —— 应当算未回答

  const stats = await json(base, "/api/account/ai-work?days=7", { headers: owner });
  assert.equal(stats.body.totals.asked, 3);
  assert.equal(stats.body.totals.answered, 1);
  assert.equal(stats.body.totals.failed, 1);
  assert.equal(stats.body.totals.unanswered, 1);
  assert.equal(stats.body.totals.replyChars, "十二个字的答案".length + "跑挂了".length);
  assert.ok(stats.body.totals.avgResponseMs >= 0);

  // 按提问人拆开 —— 工单里说这是最有说服力的一项
  const askers = Object.fromEntries(stats.body.byAsker.map((row) => [row.label, row.asked]));
  assert.deepEqual(askers, { "客人": 2, "Owner": 1 });
  assert.equal(stats.body.byGroup.length, 1);
  assert.equal(stats.body.byGroup[0].label, "工作量");
  assert.equal(stats.body.byDay.length, 1);
  assert.equal(stats.body.byProvider[0].label, "claude");

  // 别人的 AI 不出现在我的统计里
  const guestStats = await json(base, "/api/account/ai-work?days=7", { headers: guest });
  assert.equal(guestStats.body.totals.asked, 0);

  // 关键设计点:消息被保留期回收之后,工作量还在
  await store.purgeExpired({
    messageDays: 1,
    attachmentHours: 1,
    now: new Date(Date.now() + 60 * 24 * 60 * 60 * 1_000)
  });
  assert.equal((await store.readMessages(groupId)).length, 0);
  const afterPurge = await json(base, "/api/account/ai-work?days=7", { headers: owner });
  assert.equal(afterPurge.body.totals.asked, 3);
  assert.equal(afterPurge.body.totals.answered, 1);
  // 计数落在数据根目录,和 feedback.json 一样
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "ai-work.json"), "utf8"));
  assert.equal(persisted.rows.length, 2);
});

test("an AI fetching the invite link gets the onboarding sheet, not the web page", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "接入", email: "owner@example.com", displayName: "Owner" })
  });
  const url = `${base}/join/${created.body.group.inviteToken}`;
  const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  // 人的浏览器:拿到 SPA
  const browser = await fetch(url, {
    headers: { Accept: browserAccept, "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/151 Safari/537.36" }
  });
  assert.match(await browser.text(), /<!doctype html>/i);

  // AI 的抓取工具发的也是浏览器式 Accept —— 靠 Accept 判断会把说明变成网页,AI 只好拒绝接入。
  // 认 UA 兜底:
  for (const agent of ["claude-code/2.1", "curl/8.4.0", "python-requests/2.32", "Cursor/1.0"]) {
    const response = await fetch(url, { headers: { Accept: browserAccept, "User-Agent": agent } });
    const body = await response.text();
    assert.match(body, /Group Relay — AI 接入说明/, `${agent} 应当拿到接入说明`);
  }

  // 复制给 AI 的链接自己带 format=text,任何抓取工具都不会再拿到网页
  const forced = await fetch(`${url}?format=text`, {
    headers: { Accept: browserAccept, "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/151 Safari/537.36" }
  });
  const sheet = await forced.text();
  assert.match(sheet, /Group Relay — AI 接入说明/);
  // 说明里要能回答「要不要接」的三个疑问,否则一个尽责的 AI 就该拒绝
  assert.match(sheet, /不需要把任何 API key 交给这个服务/);
  assert.match(sheet, /github\.com\/cyffff\/chatBot/);
  assert.match(sheet, /GROUP_RELAY_APPROVAL_REQUIRED/);
  assert.match(sheet, /npm run relay -- join/);
  assert.match(sheet, /Windows PowerShell/);
  // 平台自己的需求要走反馈队列,不能让群里的 AI 顺手改掉 —— 免审批之下这条尤其重要
  assert.match(sheet, /不要自己动手实现/);
  assert.match(sheet, /会走反馈队列统一实现/);
});

// 公开仓库里不该出现真人身份和这台机器的细节。今天两次 git add -A 都差点(有一次真的)把
// 不该进去的东西带上 main,所以把这条变成会红的测试,而不是一句「以后注意」。
test("the tracked tree carries no real identities, hosts or credentials", async () => {
  const { stdout: tracked } = await execFileAsync("git", ["ls-files"], { maxBuffer: 10 * 1024 * 1024 });
  const files = tracked.split("\n").filter(Boolean);
  const forbidden = [
    // 模式用拼接写:上一版直接写成字面量,被我一次整串替换连带改掉,于是它开始举报所有
    // 正常使用 example.com 的文件。拼起来就不会再被这类批量替换误伤。
    { pattern: new RegExp(["astratech", "\\.", "ae"].join("")), why: "真实公司域名" },
    { pattern: /trycloudflare\.com\/[a-zA-Z0-9]/, why: "隧道上的具体路径(无鉴权入口)" },
    { pattern: /\b35\.211\.6\.86\b/, why: "服务器 IP" },
    { pattern: /cyf1379156282/, why: "服务器账号名" },
    { pattern: /\b(gho|ghp|ghs)_[A-Za-z0-9]{20,}/, why: "GitHub token" },
    { pattern: /sk-ant-[A-Za-z0-9-]{20,}/, why: "Anthropic key" },
    { pattern: /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/, why: "私钥" }
  ];
  const offenders = [];
  for (const file of files) {
    if (file === "test/app.test.js") continue;   // 这条测试自己写着这些模式
    let content;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;   // 二进制或已删除
    }
    for (const { pattern, why } of forbidden) {
      if (pattern.test(content)) offenders.push(`${file}: ${why}`);
    }
  }
  assert.deepEqual(offenders, []);
});
