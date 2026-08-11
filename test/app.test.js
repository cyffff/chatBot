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
  const { app, store, sweepExpiredTokens, movedTo, pushEverythingToNewServer } = await createApp({
    dataDir,
    publicBaseUrl: "http://relay.test",
    ...options
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, dataDir, sweepExpiredTokens, movedTo, pushEverythingToNewServer };
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
  assert.deepEqual(routed.body.messages.map((message) => message.executionScope), ["restricted", "trusted"]);

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
    [["owner command", "trusted"], ["guest command", "restricted"]]
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
  const history = await execFileAsync(process.execPath, [
    relayClient,
    "history",
    "--connection",
    "group-relay-named"
  ], { env: clientEnv });
  assert.equal(JSON.parse(history.stdout).group.name, "Named Connection");

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

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { ...asMember(created.body.member.email, created.body.member.provider) }
  });
  assert.equal(history.body.messages.length, 0);
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
    body: JSON.stringify({ email: "yunfei.cao@astratech.ae" })
  });
  assert.equal(claimed.response.status, 200);
  assert.deepEqual(
    { groups: claimed.body.groups, ais: claimed.body.ais },
    { groups: 1, ais: 1 }
  );

  // 群跟着邮箱走了
  const sessions = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "yunfei.cao@astratech.ae" }
  });
  assert.deepEqual(sessions.body.sessions.map((s) => s.group.name), ["设备身份建的群"]);
  assert.deepEqual(
    (await store.listMembers(groupId)).map((member) => member.id).sort(),
    ["ai:yunfei.cao@astratech.ae:codex", "human:yunfei.cao@astratech.ae"]
  );

  // 缓冲区里的发言人和 @ 对象一起改写,否则旧消息的 mention 全部失配
  const [buffered] = await store.readMessages(groupId);
  assert.equal(buffered.sender.id, "human:yunfei.cao@astratech.ae");
  assert.deepEqual(buffered.mentions.map((m) => m.id), ["ai:yunfei.cao@astratech.ae:codex"]);

  // 群里的人认的是设备身份那个昵称,继承过来(目标账号从没设过昵称时)
  assert.equal((await store.accountByEmail("yunfei.cao@astratech.ae")).displayName, "yunfei.cao");

  // claim 之前已经以成员身份加入过的群,不能在列表里出现两次
  const twice = await json(base, "/api/account/sessions", {
    headers: { "X-Relay-Email": "yunfei.cao@astratech.ae" }
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
