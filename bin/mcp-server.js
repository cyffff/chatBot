#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = (process.env.GROUP_RELAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const groupId = process.env.GROUP_RELAY_GROUP_ID;
const token = process.env.GROUP_RELAY_MEMBER_TOKEN;

if (!groupId || !token) {
  console.error("GROUP_RELAY_GROUP_ID and GROUP_RELAY_MEMBER_TOKEN are required");
  process.exit(1);
}

async function relay(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const retryable = !options.method
    || ["GET", "HEAD"].includes(options.method.toUpperCase())
    || options.retryNetwork === true;
  const { retryNetwork: _retryNetwork, ...fetchOptions } = options;
  const delays = retryable ? [0, 500, 1_000, 2_000, 4_000, 8_000] : [0];
  let response;
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      response = await fetch(`${baseUrl}${path}`, { ...fetchOptions, headers });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!response) {
    throw new Error(`Relay network unavailable after retries: ${lastError?.message ?? "network error"}`);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Relay returned ${response.status}`);
  return data;
}

const server = new McpServer({ name: "group-relay", version: "0.1.0" });
let presenceStatus = "online";
let groupIdentityPromise;

async function groupIdentity() {
  groupIdentityPromise ??= relay(`/api/groups/${groupId}`).then(({ group }) => ({
    id: group.id,
    name: group.name
  }));
  return groupIdentityPromise;
}

async function assertExpectedGroup(expectedGroupId) {
  const group = await groupIdentity();
  if (expectedGroupId !== group.id) {
    throw new Error(
      `Refusing to send: this MCP session is connected to "${group.name}" (${group.id}), `
      + `not the expected group ${expectedGroupId}.`
    );
  }
  return group;
}

async function reportPresence(status = presenceStatus) {
  presenceStatus = status;
  return relay(`/api/groups/${groupId}/members/me/presence`, {
    method: "POST",
    retryNetwork: true,
    body: JSON.stringify({ status })
  });
}

server.tool(
  "group_send",
  "Send a text message to the shared group conversation. Optionally mention AI members by ID.",
  {
    text: z.string().min(1).max(20_000),
    expectedGroupId: z.string().uuid(),
    status: z.enum(["processing", "complete", "failed"]).default("complete"),
    replyTo: z.string().optional(),
    mentionIds: z.array(z.string()).max(20).optional()
  },
  async ({ text, expectedGroupId, status, replyTo, mentionIds = [] }) => {
    const group = await assertExpectedGroup(expectedGroupId);
    const form = new FormData();
    form.set("text", text);
    form.set("status", status);
    if (replyTo) form.set("replyTo", replyTo);
    form.set("mentions", JSON.stringify(mentionIds));
    const result = await relay(`/api/groups/${groupId}/messages`, { method: "POST", body: form });
    await reportPresence(status === "processing" ? "busy" : "online");
    return { content: [{ type: "text", text: JSON.stringify({ group, message: result.message }) }] };
  }
);

server.tool(
  "group_update",
  "Replace this AI's existing placeholder message with progress, a completed answer, or a failure.",
  {
    messageId: z.string().uuid(),
    text: z.string().min(1).max(20_000),
    status: z.enum(["processing", "complete", "failed"]).default("complete"),
    expectedGroupId: z.string().uuid()
  },
  async ({ messageId, text, status, expectedGroupId }) => {
    const group = await assertExpectedGroup(expectedGroupId);
    const result = await relay(`/api/groups/${groupId}/messages/${messageId}`, {
      method: "PATCH",
      retryNetwork: true,
      body: JSON.stringify({ text, status, expectedGroupId })
    });
    await reportPresence(status === "processing" ? "busy" : "online");
    return { content: [{ type: "text", text: JSON.stringify({ group, message: result.message }) }] };
  }
);

server.tool(
  "group_history",
  "Read recent messages from the shared group. Pass after to read only newer messages.",
  { after: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) },
  async ({ after, limit }) => {
    const query = new URLSearchParams({ limit: String(limit) });
    query.set("routed", "1");
    if (after) query.set("after", after);
    const result = await relay(`/api/groups/${groupId}/messages?${query}`);
    if (result.messages.length) await reportPresence("busy");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ group: await groupIdentity(), ...result })
      }]
    };
  }
);

server.tool(
  "group_wait",
  "Wait up to 30 seconds for another group message. Use the last cursor as after.",
  { after: z.string().optional(), timeoutMs: z.number().int().min(1000).max(30000).default(25000) },
  async ({ after, timeoutMs }) => {
    const query = new URLSearchParams({ timeoutMs: String(timeoutMs), routed: "1" });
    if (after) query.set("after", after);
    const result = await relay(`/api/groups/${groupId}/messages/wait?${query}`);
    if (result.messages.length) await reportPresence("busy");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ group: await groupIdentity(), ...result })
      }]
    };
  }
);

server.tool("group_members", "List members in the shared group.", {}, async () => {
  const result = await relay(`/api/groups/${groupId}`);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        group: { id: result.group.id, name: result.group.name },
        members: result.members
      })
    }]
  };
});

server.tool(
  "group_presence",
  "Set this AI member's presence to online or busy.",
  { status: z.enum(["online", "busy"]) },
  async ({ status }) => {
    const result = await reportPresence(status);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

await reportPresence("online");
setInterval(() => {
  reportPresence().catch((error) => console.error(`Heartbeat error: ${error.message}`));
}, 60_000).unref();

await server.connect(new StdioServerTransport());
