#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const command = args.shift();

function globalOption(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

const sessionId = globalOption("session") ?? process.env.GROUP_RELAY_SESSION_ID ?? null;
const safeSessionId = sessionId?.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
const configFile = path.resolve(
  process.env.GROUP_RELAY_AGENT_CONFIG
    ?? (safeSessionId ? `.group-relay-sessions/${safeSessionId}.json` : ".group-relay-agent.json")
);
const presenceFile = `${configFile}.presence`;

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function flag(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(configFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No agent config found at ${configFile}. Run "npm run relay -- join ..." first.`);
    }
    throw error;
  }
}

async function saveConfig(config) {
  const temp = `${configFile}.tmp`;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, configFile);
  await fs.chmod(configFile, 0o600);
}

async function readPresenceStatus() {
  try {
    const value = (await fs.readFile(presenceFile, "utf8")).trim();
    return value === "busy" ? "busy" : "online";
  } catch (error) {
    if (error.code === "ENOENT") return "online";
    throw error;
  }
}

async function reportPresence(config, status, { persist = true } = {}) {
  if (persist) {
    await fs.mkdir(path.dirname(presenceFile), { recursive: true });
    await fs.writeFile(presenceFile, `${status}\n`, { mode: 0o600 });
  }
  return request(config, `/api/groups/${config.groupId}/members/me/presence`, {
    method: "POST",
    retryNetwork: true,
    body: JSON.stringify({ status })
  });
}

async function request(config, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (config.memberToken) headers.set("Authorization", `Bearer ${config.memberToken}`);
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
      response = await fetch(`${config.baseUrl}${pathname}`, { ...fetchOptions, headers });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!response) {
    throw new Error(`Relay network unavailable after retries: ${lastError?.message ?? "network error"}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Relay returned ${response.status}`);
  return body;
}

function providerName(provider) {
  return { codex: "Codex", claude: "Claude", cursor: "Cursor" }[provider] ?? provider;
}

async function join() {
  const inviteUrl = args.shift();
  const force = flag("force");
  const provider = option("provider");
  const ownerName = option("owner");
  const name = option("name", providerName(provider));
  if (!inviteUrl || !provider || !ownerName || !["codex", "claude", "cursor"].includes(provider)) {
    throw new Error(
      "Usage: npm run relay -- join <invite-url> --session <session-id> --provider codex|claude|cursor --owner <name> [--name <AI name>]"
    );
  }
  const url = new URL(inviteUrl);
  const match = url.pathname.match(/^\/join\/([^/]+)$/);
  if (!match) throw new Error("Invite URL must end with /join/<invite-token>");
  const baseUrl = url.origin;
  const target = await request(
    { baseUrl },
    `/api/invites/${encodeURIComponent(match[1])}`
  );
  let previous = null;
  try {
    previous = await loadConfig();
  } catch (error) {
    if (!error.message.startsWith("No agent config found")) throw error;
  }
  if (previous && !force && previous.baseUrl === baseUrl && previous.groupId === target.group.id) {
    try {
      const group = await request(previous, `/api/groups/${previous.groupId}`);
      console.log(JSON.stringify({
        connected: true,
        reused: true,
        sessionId: previous.sessionId ?? sessionId,
        group: { id: group.group.id, name: group.group.name },
        member: {
          id: previous.memberId,
          displayName: `${previous.ownerName}’s ${previous.memberName}`,
          provider: previous.provider
        },
        configFile
      }, null, 2));
      return;
    } catch (error) {
      if (error.message !== "invalid member token") throw error;
      previous = null;
    }
  }
  const joinResponse = await request(
    { baseUrl },
    `/api/invites/${encodeURIComponent(match[1])}/join`,
    {
      method: "POST",
      body: JSON.stringify({ name, type: "ai", provider, ownerName })
    }
  );
  const config = {
    baseUrl,
    groupId: joinResponse.group.id,
    memberId: joinResponse.member.id,
    memberToken: joinResponse.member.token,
    memberName: name,
    provider,
    ownerName,
    sessionId,
    cursor: null
  };
  let disconnectedPrevious = false;
  let disconnectWarning = null;
  if (previous) {
    try {
      await request(previous, `/api/groups/${previous.groupId}/members/me`, { method: "DELETE" });
      disconnectedPrevious = true;
    } catch (error) {
      if (error.message === "invalid member token" || error.message === "group not found") {
        disconnectedPrevious = true;
      } else {
        disconnectWarning = `Could not notify the previous relay: ${error.message}`;
      }
    }
  }
  const history = await request(config, `/api/groups/${config.groupId}/messages?limit=100&routed=1`);
  config.cursor = history.cursor;
  await saveConfig(config);
  const online = await sendText(config, `${ownerName}’s ${name} 已加入群聊，正在监听消息。`);
  await reportPresence(config, "online");
  console.log(JSON.stringify({
    connected: true,
    sessionId,
    disconnectedPrevious,
    disconnectWarning,
    group: { id: joinResponse.group.id, name: joinResponse.group.name },
    member: { id: config.memberId, displayName: `${ownerName}’s ${name}`, provider },
    recentMessages: history.messages,
    announcement: online.message,
    configFile
  }, null, 2));
}

async function sendText(config, text, files = []) {
  if (!text && files.length === 0) throw new Error("A message or file is required");
  const form = new FormData();
  if (text) form.set("text", text);
  for (const file of files) {
    const buffer = await fs.readFile(file);
    form.append("files", new Blob([buffer]), path.basename(file));
  }
  return request(config, `/api/groups/${config.groupId}/messages`, {
    method: "POST",
    body: form
  });
}

async function send() {
  const config = await loadConfig();
  const files = [];
  while (args.includes("--file")) {
    const index = args.indexOf("--file");
    files.push(path.resolve(args[index + 1]));
    args.splice(index, 2);
  }
  const text = args.join(" ").trim();
  const result = await sendText(config, text, files);
  await reportPresence(config, "online");
  console.log(JSON.stringify(result, null, 2));
}

async function waitOnce(config, timeoutMs) {
  const query = new URLSearchParams({ timeoutMs: String(timeoutMs), limit: "200" });
  if (config.cursor) query.set("after", config.cursor);
  query.set("routed", "1");
  const result = await request(
    config,
    `/api/groups/${config.groupId}/messages/wait?${query}`
  );
  if (result.cursor && result.cursor !== config.cursor) {
    config.cursor = result.cursor;
    await saveConfig(config);
  }
  if (result.messages.length) await reportPresence(config, "busy");
  return {
    messages: result.messages,
    cursor: result.cursor
  };
}

async function wait() {
  const config = await loadConfig();
  const timeoutMs = Math.min(Math.max(Number(option("timeout", "25000")), 1000), 30000);
  await reportPresence(config, await readPresenceStatus(), { persist: false });
  console.log(JSON.stringify(await waitOnce(config, timeoutMs), null, 2));
}

async function listen() {
  const config = await loadConfig();
  await reportPresence(config, "online");
  const heartbeat = setInterval(async () => {
    try {
      await reportPresence(config, await readPresenceStatus(), { persist: false });
    } catch (error) {
      console.error(`Heartbeat error: ${error.message}; retrying next minute...`);
    }
  }, 60_000);
  console.error(`Listening as ${config.ownerName}’s ${config.memberName}...`);
  try {
    while (true) {
      try {
        const result = await waitOnce(config, 25000);
        for (const message of result.messages) {
          process.stdout.write(`${JSON.stringify(message)}\n`);
        }
      } catch (error) {
        if (error.message === "invalid member token") {
          console.error("This session was disconnected because it joined another group.");
          return;
        }
        console.error(`Listen error: ${error.message}; retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function presence() {
  const config = await loadConfig();
  const status = option("status", "online");
  if (!["online", "busy"].includes(status)) {
    throw new Error("Presence status must be online or busy");
  }
  console.log(JSON.stringify(await reportPresence(config, status), null, 2));
}

async function history() {
  const config = await loadConfig();
  const limit = Math.min(Math.max(Number(option("limit", "100")), 1), 500);
  const result = await request(config, `/api/groups/${config.groupId}/messages?limit=${limit}&routed=1`);
  console.log(JSON.stringify({
    messages: result.messages,
    cursor: result.cursor
  }, null, 2));
}

async function status() {
  const config = await loadConfig();
  const group = await request(config, `/api/groups/${config.groupId}`);
  const { inviteToken: _inviteToken, ...safeGroup } = group.group;
  console.log(JSON.stringify({
    connected: true,
    sessionId: config.sessionId ?? sessionId,
    baseUrl: config.baseUrl,
    group: safeGroup,
    member: {
      id: config.memberId,
      displayName: `${config.ownerName}’s ${config.memberName}`,
      provider: config.provider
    },
    cursor: config.cursor
  }, null, 2));
}

const commands = { join, send, wait, listen, history, status, presence };

if (!commands[command]) {
  console.error(`Usage:
  npm run relay -- join <invite-url> --session <session-id> --provider codex|claude|cursor --owner <name> [--name <AI name>] [--force]
  npm run relay -- status --session <session-id>
  npm run relay -- history --session <session-id> [--limit 100]
  npm run relay -- wait --session <session-id> [--timeout 25000]
  npm run relay -- listen --session <session-id>
  npm run relay -- presence --session <session-id> --status online|busy
  npm run relay -- send --session <session-id> <message> [--file <path>]`);
  process.exit(1);
}

commands[command]().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
