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
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Relay returned ${response.status}`);
  return data;
}

const server = new McpServer({ name: "group-relay", version: "0.1.0" });

server.tool(
  "group_send",
  "Send a text message to the shared group conversation. Optionally mention AI members by ID.",
  {
    text: z.string().min(1).max(20_000),
    replyTo: z.string().optional(),
    mentionIds: z.array(z.string()).max(20).optional()
  },
  async ({ text, replyTo, mentionIds = [] }) => {
    const form = new FormData();
    form.set("text", text);
    if (replyTo) form.set("replyTo", replyTo);
    form.set("mentions", JSON.stringify(mentionIds));
    const result = await relay(`/api/groups/${groupId}/messages`, { method: "POST", body: form });
    return { content: [{ type: "text", text: JSON.stringify(result.message) }] };
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
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool("group_members", "List members in the shared group.", {}, async () => {
  const result = await relay(`/api/groups/${groupId}`);
  return { content: [{ type: "text", text: JSON.stringify(result.members) }] };
});

await server.connect(new StdioServerTransport());
