#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { loadSecurityConfig, assertFilePathSendable } from "./security.js";

// 附件默认类型表:光靠扩展名给浏览器一个像样的 Content-Type,md/docx/pdf 之类能被正确
// 识别并下载,认不出的一律 octet-stream(下载路由会强制 attachment,不会当页面渲染)。
const MIME_BY_EXT = {
  ".md": "text/markdown", ".markdown": "text/markdown",
  ".html": "text/html", ".htm": "text/html",
  ".txt": "text/plain", ".log": "text/plain",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".xml": "application/xml",
  ".yaml": "text/yaml", ".yml": "text/yaml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip", ".gz": "application/gzip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp"
};

// 和服务端同一个变量(src/app.js 读的是 MAX_FILE_SIZE_MB)。名字不一致的话,把服务端上限
// 调小之后这里仍然放行,失败会变成 multer 的报错而不是一句说得清的提示。
const maxFileBytes = Number(process.env.MAX_FILE_SIZE_MB ?? 25) * 1024 * 1024;

// 本机数据安全策略,进程启动时读一次(三个开关默认关闭,行为与历史一致)。
const security = loadSecurityConfig();

const baseUrl = (process.env.GROUP_RELAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const groupId = process.env.GROUP_RELAY_GROUP_ID;
const email = process.env.GROUP_RELAY_EMAIL;
const provider = process.env.GROUP_RELAY_PROVIDER;

if (!groupId || !email) {
  console.error("GROUP_RELAY_GROUP_ID and GROUP_RELAY_EMAIL are required");
  process.exit(1);
}

async function relay(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("X-Relay-Email", email);
  if (provider) headers.set("X-Relay-Provider", provider);
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

/// 读也要对齐群。写工具一开始就要 expectedGroupId,读工具却直接用连接里写死的那个群 ——
/// 于是 AI 在 A 群里被 @,顺手 group_history 翻的是这个连接绑的 B 群,拿 B 群的历史回答了
/// A 群的问题(实测出现过)。读工具现在同样必须显式说明「我以为我在哪个群」。
async function assertExpectedGroup(expectedGroupId) {
  const group = await groupIdentity();
  if (expectedGroupId !== group.id) {
    throw new Error(
      `Refusing to act: this MCP connection is bound to "${group.name}" (${group.id}), `
      + `not the expected group ${expectedGroupId}. `
      + "Pass expectedGroupId from the message you are answering; if it differs, this connection "
      + "cannot read or write that group — say so instead of using another group's history."
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
  "group_send_file",
  "Deliver a generated file (Markdown, HTML, docx, xlsx, pdf, csv, png, …) to the group so a "
  + "human can download it. Generate the file on this machine first, then either pass filePath to "
  + "attach it from disk, or pass inline content plus a filename. Add an optional text caption. The "
  + "file appears in the conversation as a download link; images also show a thumbnail.",
  {
    expectedGroupId: z.string().uuid(),
    filePath: z.string().min(1).optional().describe("Absolute or relative path to a file on this machine"),
    content: z.string().optional().describe("Inline file contents; requires filename"),
    encoding: z.enum(["utf8", "base64"]).default("utf8")
      .describe("How content is encoded — use base64 for binary files"),
    filename: z.string().min(1).max(200).optional()
      .describe("Name shown to the user; required with content, defaults to the basename of filePath"),
    mimeType: z.string().max(120).optional().describe("Override the auto-detected content type"),
    text: z.string().max(20_000).optional().describe("Optional message caption sent alongside the file"),
    status: z.enum(["processing", "complete", "failed"]).default("complete"),
    mentionIds: z.array(z.string()).max(20).optional()
  },
  async ({ expectedGroupId, filePath, content, encoding, filename, mimeType, text, status, mentionIds = [] }) => {
    const group = await assertExpectedGroup(expectedGroupId);
    let bytes;
    let name;
    if (filePath) {
      // 附本机文件前先过数据安全策略:文件下载开关、目录结构开关、目录白名单。
      await assertFilePathSendable(filePath, security);
      bytes = await fs.readFile(filePath);
      name = filename || path.basename(filePath);
    } else if (content != null) {
      if (!filename) throw new Error("filename is required when sending inline content");
      bytes = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
      name = filename;
    } else {
      throw new Error("Provide either filePath or content");
    }
    if (!name) throw new Error("Could not determine a filename for the attachment");
    if (bytes.length === 0) throw new Error("Refusing to send an empty file");
    if (bytes.length > maxFileBytes) {
      throw new Error(
        `File is ${(bytes.length / 1_048_576).toFixed(1)}MB, over the `
        + `${(maxFileBytes / 1_048_576).toFixed(0)}MB attachment limit`
      );
    }
    const type = mimeType || MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";
    const form = new FormData();
    if (text) form.set("text", text);
    form.set("status", status);
    form.set("mentions", JSON.stringify(mentionIds));
    form.set("files", new Blob([bytes], { type }), name);
    const result = await relay(`/api/groups/${groupId}/messages`, { method: "POST", body: form });
    await reportPresence(status === "processing" ? "busy" : "online");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ group, message: result.message, attachments: result.message?.attachments ?? [] })
      }]
    };
  }
);

server.tool(
  "group_history",
  "Read recent messages from the shared group. Pass expectedGroupId (the groupId of the message "
  + "you are answering) so a wrong-group read fails loudly instead of returning another group's "
  + "history. Pass after to read only newer messages.",
  {
    expectedGroupId: z.string().uuid(),
    after: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(100)
  },
  async ({ expectedGroupId, after, limit }) => {
    await assertExpectedGroup(expectedGroupId);
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
  "Wait up to 30 seconds for another group message. Use the last cursor as after. "
  + "expectedGroupId must be the groupId you believe you are in.",
  {
    expectedGroupId: z.string().uuid(),
    after: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(30000).default(25000)
  },
  async ({ expectedGroupId, after, timeoutMs }) => {
    await assertExpectedGroup(expectedGroupId);
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

server.tool(
  "group_members",
  "List members in the shared group. expectedGroupId must be the groupId you believe you are in.",
  { expectedGroupId: z.string().uuid() },
  async ({ expectedGroupId }) => {
    await assertExpectedGroup(expectedGroupId);
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
  }
);

server.tool(
  "submit_feedback",
  "File a Group Relay feedback ticket. Only AIs may file them: when a human asks for a change, "
  + "rewrite their words into a clear problem statement plus the expected behaviour, then submit "
  + "that, naming who asked in onBehalfOf.",
  {
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(4000),
    onBehalfOf: z.string().max(80).optional(),
    sourceMessageId: z.string().optional()
  },
  async ({ title, body, onBehalfOf, sourceMessageId }) => {
    const result = await relay("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ title, body, onBehalfOf, groupId, sourceMessageId })
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

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
