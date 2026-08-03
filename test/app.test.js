import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const relayClient = path.resolve("bin/relay-client.js");
const codexWorker = path.resolve("bin/codex-worker.js");
const codexHook = path.resolve("bin/codex-hook.js");
const codexHookInstaller = path.resolve("bin/install-codex-hooks.js");
const mcpServer = path.resolve("bin/mcp-server.js");

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
  const { app, store } = await createApp({
    dataDir,
    publicBaseUrl: "http://relay.test",
    ...options
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, dataDir };
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
    body: JSON.stringify({ name: "Architecture", ownerName: "Yunfei" })
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
    body: JSON.stringify({ name: "Codex", type: "ai", provider: "codex", ownerName: "Yunfei" })
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.member.provider, "codex");
  assert.equal(joined.body.member.ownerName, "Yunfei");

  const form = new FormData();
  form.set("text", "Hello from Codex");
  form.set("files", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
  const sentResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${joined.body.member.token}` },
    body: form
  });
  assert.equal(sentResponse.status, 201);

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(history.body.messages.length, 1);
  assert.equal(history.body.messages[0].text, "Hello from Codex");
  assert.equal(history.body.messages[0].sender.ownerName, "Yunfei");
  assert.equal(history.body.messages[0].attachments[0].name, "notes.txt");
});

test("rejects unauthenticated history access", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Private", ownerName: "Owner" })
  });
  const response = await fetch(`${base}/api/groups/${created.body.group.id}/messages`);
  assert.equal(response.status, 401);
});

test("email accounts import validated browser sessions and list joined groups", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "iOS group", ownerName: "Yunfei" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "YUNFEI@example.com" })
  });
  assert.equal(account.response.status, 201);
  assert.equal(account.body.account.email, "yunfei@example.com");
  assert.ok(account.body.accountToken);

  const duplicate = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "yunfei@example.com" })
  });
  assert.equal(duplicate.response.status, 409);

  const imported = await json(base, "/api/account/sessions/import", {
    method: "POST",
    headers: { "X-Account-Token": account.body.accountToken },
    body: JSON.stringify({
      sessions: [
        {
          groupId: created.body.group.id,
          memberToken: created.body.member.token
        },
        {
          groupId: crypto.randomUUID(),
          memberToken: "wrong-token"
        }
      ]
    })
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.imported, 1);
  assert.equal(imported.body.rejected.length, 1);
  assert.equal(imported.body.sessions[0].group.name, "iOS group");
  assert.equal(imported.body.sessions[0].member.name, "Yunfei");
  assert.equal(imported.body.sessions[0].memberToken, created.body.member.token);

  const listed = await json(base, "/api/account/sessions", {
    headers: { "X-Account-Token": account.body.accountToken }
  });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.sessions.length, 1);

  const unauthorized = await json(base, "/api/account/sessions", {
    headers: { "X-Account-Token": "wrong" }
  });
  assert.equal(unauthorized.response.status, 401);
});

test("one-click browser transfer imports sessions into the current account", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Chrome session", ownerName: "Yunfei" })
  });
  const account = await json(base, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: "one-click@example.com" })
  });
  const transfer = await json(base, "/api/account/browser-transfers", {
    method: "POST",
    headers: { "X-Account-Token": account.body.accountToken },
    body: "{}"
  });
  assert.equal(transfer.response.status, 201);
  assert.match(transfer.body.transferUrl, /\/transfer\//);

  const imported = await json(base, `/api/browser-transfers/${transfer.body.transferToken}/import`, {
    method: "POST",
    body: JSON.stringify({
      sessions: [{
        groupId: created.body.group.id,
        memberToken: created.body.member.token
      }]
    })
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.status, "completed");
  assert.equal(imported.body.imported, 1);

  const status = await json(base, `/api/account/browser-transfers/${transfer.body.transferToken}`, {
    headers: { "X-Account-Token": account.body.accountToken }
  });
  assert.equal(status.body.status, "completed");

  const reused = await json(base, `/api/browser-transfers/${transfer.body.transferToken}/import`, {
    method: "POST",
    body: JSON.stringify({ sessions: [] })
  });
  assert.equal(reused.response.status, 409);

  const sessions = await json(base, "/api/account/sessions", {
    headers: { "X-Account-Token": account.body.accountToken }
  });
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].group.name, "Chrome session");
});

test("long polling delivers a new message without refreshing", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Realtime", ownerName: "Owner" })
  });
  const groupId = created.body.group.id;
  const token = created.body.member.token;
  const waitRequest = fetch(`${base}/api/groups/${groupId}/messages/wait?timeoutMs=2000`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then(async (response) => ({ response, body: await response.json() }));

  await new Promise((resolve) => setTimeout(resolve, 50));
  const form = new FormData();
  form.set("text", "live message");
  const sent = await fetch(`${base}/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
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
    body: JSON.stringify({ name: "Presence Events", ownerName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Codex",
      type: "ai",
      provider: "codex",
      ownerName: "Yunfei"
    })
  });
  const waitRequest = json(
    base,
    `/api/groups/${created.body.group.id}/messages/wait?timeoutMs=2000`,
    { headers: { Authorization: `Bearer ${created.body.member.token}` } }
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  await json(base, `/api/groups/${created.body.group.id}/members/me/presence`, {
    method: "POST",
    headers: { Authorization: `Bearer ${joined.body.member.token}` },
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
    body: JSON.stringify({ name: "Mentions", ownerName: "Owner" })
  });
  const inviteToken = created.body.group.inviteToken;
  const codex = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Codex",
      type: "ai",
      provider: "codex",
      ownerName: "Yunfei"
    })
  });
  const claude = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Claude",
      type: "ai",
      provider: "claude",
      ownerName: "Zoe"
    })
  });

  const form = new FormData();
  form.set("text", "@Yunfei’s Codex 请回答这个问题");
  form.set("mentions", JSON.stringify([codex.body.member.id]));
  const sentResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.body.member.token}` },
    body: form
  });
  assert.equal(sentResponse.status, 201);
  const sent = await sentResponse.json();
  assert.equal(sent.message.mentions[0].id, codex.body.member.id);

  const forCodex = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { Authorization: `Bearer ${codex.body.member.token}` } }
  );
  assert.equal(forCodex.body.messages.length, 1);
  assert.equal(forCodex.body.messages[0].text, "@Yunfei’s Codex 请回答这个问题");

  const forClaude = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { Authorization: `Bearer ${claude.body.member.token}` } }
  );
  assert.equal(forClaude.body.messages.length, 0);
  assert.equal(forClaude.body.cursor, sent.message.id);

  const placeholder = new FormData();
  placeholder.set("text", "正在处理这个问题，请稍等…");
  placeholder.set("status", "processing");
  const placeholderResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${codex.body.member.token}` },
    body: placeholder
  });
  assert.equal(placeholderResponse.status, 201);

  const placeholderForClaude = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { Authorization: `Bearer ${claude.body.member.token}` } }
  );
  assert.equal(placeholderForClaude.body.messages.length, 0);

  const aiMention = new FormData();
  aiMention.set("text", "@Zoe’s Claude 请协助核对");
  aiMention.set("mentions", JSON.stringify([claude.body.member.id]));
  const aiMentionResponse = await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${codex.body.member.token}` },
    body: aiMention
  });
  assert.equal(aiMentionResponse.status, 201);

  const explicitForClaude = await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { Authorization: `Bearer ${claude.body.member.token}` } }
  );
  assert.equal(explicitForClaude.body.messages.length, 1);
  assert.equal(explicitForClaude.body.messages[0].text, "@Zoe’s Claude 请协助核对");
});

test("AI presence changes from busy to offline when heartbeats expire", async (t) => {
  const { base } = await fixture(t, { presenceTimeoutMs: 30 });
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Presence", ownerName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Codex",
      type: "ai",
      provider: "codex",
      ownerName: "Yunfei"
    })
  });
  const busy = await json(
    base,
    `/api/groups/${created.body.group.id}/members/me/presence`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${joined.body.member.token}` },
      body: JSON.stringify({ status: "busy" })
    }
  );
  assert.equal(busy.body.presence.status, "busy");

  const active = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(active.body.members.find((member) => member.type === "ai").presence.status, "busy");

  await new Promise((resolve) => setTimeout(resolve, 40));
  const expired = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(expired.body.members.find((member) => member.type === "ai").presence.status, "offline");
});

test("AI polling renews presence and routed work marks it busy", async (t) => {
  const { base } = await fixture(t, { presenceTimeoutMs: 1500 });
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Polling Presence", ownerName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Codex",
      type: "ai",
      provider: "codex",
      ownerName: "Yunfei"
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 1600));
  await json(
    base,
    `/api/groups/${created.body.group.id}/messages/wait?timeoutMs=1000&routed=1`,
    { headers: { Authorization: `Bearer ${joined.body.member.token}` } }
  );
  const online = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(online.body.members.find((member) => member.type === "ai").presence.status, "online");

  const form = new FormData();
  form.set("text", "@Codex are you there?");
  form.set("mentions", JSON.stringify([joined.body.member.id]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.body.member.token}` },
    body: form
  });
  await json(
    base,
    `/api/groups/${created.body.group.id}/messages?routed=1`,
    { headers: { Authorization: `Bearer ${joined.body.member.token}` } }
  );
  const busy = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(busy.body.members.find((member) => member.type === "ai").presence.status, "busy");
});

test("AI processing placeholders stay busy and are updated in place", async (t) => {
  const { base } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Processing", ownerName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Codex",
      type: "ai",
      provider: "codex",
      ownerName: "Yunfei"
    })
  });
  const placeholderForm = new FormData();
  placeholderForm.set("text", "正在处理这个问题，请稍等…");
  placeholderForm.set("status", "processing");
  const placeholderResponse = await fetch(
    `${base}/api/groups/${created.body.group.id}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${joined.body.member.token}` },
      body: placeholderForm
    }
  );
  const placeholder = await placeholderResponse.json();
  assert.equal(placeholder.message.status, "processing");

  const attemptedOnline = await json(base, `/api/groups/${created.body.group.id}/members/me/presence`, {
    method: "POST",
    headers: { Authorization: `Bearer ${joined.body.member.token}` },
    body: JSON.stringify({ status: "online" })
  });
  assert.equal(attemptedOnline.body.presence.status, "busy");
  const stillBusy = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(stillBusy.body.members.find((member) => member.type === "ai").presence.status, "busy");

  const waitForUpdate = json(
    base,
    `/api/groups/${created.body.group.id}/messages/wait?after=${placeholder.message.id}&timeoutMs=2000`,
    { headers: { Authorization: `Bearer ${created.body.member.token}` } }
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const completed = await json(
    base,
    `/api/groups/${created.body.group.id}/messages/${placeholder.message.id}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${joined.body.member.token}` },
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
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(history.body.messages.length, 1);
  assert.equal(history.body.messages[0].text, "这是完整答案");
  assert.equal(history.body.messages[0].status, "complete");
  const online = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(online.body.members.find((member) => member.type === "ai").presence.status, "online");
});

test("AI relay client joins, persists identity, receives and sends messages", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Agent Group", ownerName: "Owner" })
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
    headers: { Authorization: `Bearer ${created.body.member.token}` },
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
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(busyState.body.members.find((member) => member.type === "ai").presence.status, "busy");

  const reply = await execFileAsync(process.execPath, [
    relayClient,
    "send",
    "Review complete"
  ], { env: clientEnv });
  assert.equal(JSON.parse(reply.stdout).message.text, "Review complete");
  const onlineState = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(onlineState.body.members.find((member) => member.type === "ai").presence.status, "online");

  const clientStatus = await execFileAsync(process.execPath, [
    relayClient,
    "status"
  ], { env: clientEnv });
  assert.doesNotMatch(clientStatus.stdout, /memberToken|inviteToken/);
});

test("relay named connections read the correct group and reject cross-group sends", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Named Connection", ownerName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Codex",
      type: "ai",
      provider: "codex",
      ownerName: "Yunfei"
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
GROUP_RELAY_MEMBER_TOKEN = "${joined.body.member.token}"
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
    body: JSON.stringify({ name: "Worker Group", ownerName: "Owner" })
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
    "--name",
    "Codex"
  ], { env: workerEnv });
  const aiMemberId = JSON.parse(joined.stdout).member.id;

  const question = new FormData();
  question.set("text", "@Codex 请回复");
  question.set("mentions", JSON.stringify([aiMemberId]));
  await fetch(`${base}/api/groups/${created.body.group.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.body.member.token}` },
    body: question
  });

  await execFileAsync(process.execPath, [
    codexWorker,
    "--once",
    "--codex-bin",
    fakeCodex
  ], { env: workerEnv, timeout: 10_000 });

  const history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(history.body.messages.at(-1).text, "常驻 Worker 已自动回复");
  assert.equal(history.body.messages.at(-1).sender.id, aiMemberId);
  assert.equal(history.body.messages.at(-1).status, "complete");
});

test("Codex Mac hooks mark busy, create a placeholder and fill the final reply", async (t) => {
  const { base, dataDir } = await fixture(t);
  const created = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Hook Group", ownerName: "Owner" })
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
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  const ai = groupState.body.members.find((member) => member.type === "ai");
  assert.equal(ai.presence.status, "busy");

  let history = await json(base, `/api/groups/${created.body.group.id}/messages`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
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
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(history.body.messages.at(-1).id, placeholder.id);
  assert.equal(history.body.messages.at(-1).text, "Hook 已回填最终答案");
  assert.equal(history.body.messages.at(-1).status, "complete");
  groupState = await json(base, `/api/groups/${created.body.group.id}`, {
    headers: { Authorization: `Bearer ${created.body.member.token}` }
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
    body: JSON.stringify({ name: "Background Group", ownerName: "Owner" })
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
    body: JSON.stringify({ name: "Guarded Group", ownerName: "Owner" })
  });
  const joined = await json(base, `/api/invites/${created.body.group.inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "Codex",
      type: "ai",
      provider: "codex",
      ownerName: "Yunfei"
    })
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServer],
    env: {
      ...process.env,
      GROUP_RELAY_URL: base,
      GROUP_RELAY_GROUP_ID: created.body.group.id,
      GROUP_RELAY_MEMBER_TOKEN: joined.body.member.token
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
    headers: { Authorization: `Bearer ${created.body.member.token}` }
  });
  assert.equal(history.body.messages.length, 0);
});

test("one AI session switches groups and disconnects its previous membership", async (t) => {
  const { base, dataDir } = await fixture(t);
  const first = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "First Group", ownerName: "First Owner" })
  });
  const second = await json(base, "/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: "Second Group", ownerName: "Second Owner" })
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
    headers: { Authorization: `Bearer ${first.body.member.token}` }
  });
  assert.equal(firstState.body.members.some((member) => member.type === "ai"), false);

  const secondState = await json(base, `/api/groups/${second.body.group.id}`, {
    headers: { Authorization: `Bearer ${second.body.member.token}` }
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
    "--name",
    "Codex"
  ], { env: otherSessionEnv });

  const firstWithOtherSession = await json(base, `/api/groups/${first.body.group.id}`, {
    headers: { Authorization: `Bearer ${first.body.member.token}` }
  });
  assert.equal(firstWithOtherSession.body.members.filter((member) => member.type === "ai").length, 1);
  const secondStillConnected = await json(base, `/api/groups/${second.body.group.id}`, {
    headers: { Authorization: `Bearer ${second.body.member.token}` }
  });
  assert.equal(secondStillConnected.body.members.filter((member) => member.type === "ai").length, 1);
});

test("compresses message logs from previous days and can still read them", async (t) => {
  const { store } = await fixture(t);
  const { group, owner } = await store.createGroup({ name: "Archive", ownerName: "Owner" });
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
