import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const relayClient = path.resolve("bin/relay-client.js");
const codexWorker = path.resolve("bin/codex-worker.js");

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
