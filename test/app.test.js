import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-relay-"));
  const { app, store } = await createApp({
    dataDir,
    publicBaseUrl: "http://relay.test"
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
  const joined = await json(base, `/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ name: "Codex", type: "ai", provider: "codex" })
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.member.provider, "codex");

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
