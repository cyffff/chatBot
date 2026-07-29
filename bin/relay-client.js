#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const configFile = path.resolve(
  process.env.GROUP_RELAY_AGENT_CONFIG ?? ".group-relay-agent.json"
);
const args = process.argv.slice(2);
const command = args.shift();

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
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, configFile);
  await fs.chmod(configFile, 0o600);
}

async function request(config, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (config.memberToken) headers.set("Authorization", `Bearer ${config.memberToken}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${config.baseUrl}${pathname}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Relay returned ${response.status}`);
  return body;
}

function providerName(provider) {
  return { codex: "Codex", claude: "Claude", cursor: "Cursor" }[provider] ?? provider;
}

function visibleMessage(message, ownMemberId) {
  return message.sender?.id !== ownMemberId;
}

async function join() {
  const inviteUrl = args.shift();
  const force = flag("force");
  const provider = option("provider");
  const ownerName = option("owner");
  const name = option("name", providerName(provider));
  if (!inviteUrl || !provider || !ownerName || !["codex", "claude", "cursor"].includes(provider)) {
    throw new Error(
      "Usage: npm run relay -- join <invite-url> --provider codex|claude|cursor --owner <name> [--name <AI name>]"
    );
  }
  if (!force) {
    try {
      await fs.access(configFile);
      throw new Error(
        `Agent config already exists at ${configFile}. Run "npm run relay -- status" or add --force to replace it.`
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const url = new URL(inviteUrl);
  const match = url.pathname.match(/^\/join\/([^/]+)$/);
  if (!match) throw new Error("Invite URL must end with /join/<invite-token>");
  const baseUrl = url.origin;
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
    cursor: null
  };
  const history = await request(config, `/api/groups/${config.groupId}/messages?limit=100`);
  config.cursor = history.cursor;
  await saveConfig(config);
  const online = await sendText(config, `${ownerName}’s ${name} 已加入群聊，正在监听消息。`);
  console.log(JSON.stringify({
    connected: true,
    group: { id: joinResponse.group.id, name: joinResponse.group.name },
    member: { id: config.memberId, displayName: `${ownerName}’s ${name}`, provider },
    recentMessages: history.messages.filter((message) => visibleMessage(message, config.memberId)),
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
  console.log(JSON.stringify(await sendText(config, text, files), null, 2));
}

async function waitOnce(config, timeoutMs) {
  const query = new URLSearchParams({ timeoutMs: String(timeoutMs), limit: "200" });
  if (config.cursor) query.set("after", config.cursor);
  const result = await request(
    config,
    `/api/groups/${config.groupId}/messages/wait?${query}`
  );
  if (result.cursor && result.cursor !== config.cursor) {
    config.cursor = result.cursor;
    await saveConfig(config);
  }
  return {
    messages: result.messages.filter((message) => visibleMessage(message, config.memberId)),
    cursor: result.cursor
  };
}

async function wait() {
  const config = await loadConfig();
  const timeoutMs = Math.min(Math.max(Number(option("timeout", "25000")), 1000), 30000);
  console.log(JSON.stringify(await waitOnce(config, timeoutMs), null, 2));
}

async function listen() {
  const config = await loadConfig();
  console.error(`Listening as ${config.ownerName}’s ${config.memberName}...`);
  while (true) {
    try {
      const result = await waitOnce(config, 25000);
      for (const message of result.messages) {
        process.stdout.write(`${JSON.stringify(message)}\n`);
      }
    } catch (error) {
      console.error(`Listen error: ${error.message}; retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

async function history() {
  const config = await loadConfig();
  const limit = Math.min(Math.max(Number(option("limit", "100")), 1), 500);
  const result = await request(config, `/api/groups/${config.groupId}/messages?limit=${limit}`);
  console.log(JSON.stringify({
    messages: result.messages.filter((message) => visibleMessage(message, config.memberId)),
    cursor: result.cursor
  }, null, 2));
}

async function status() {
  const config = await loadConfig();
  const group = await request(config, `/api/groups/${config.groupId}`);
  const { inviteToken: _inviteToken, ...safeGroup } = group.group;
  console.log(JSON.stringify({
    connected: true,
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

const commands = { join, send, wait, listen, history, status };

if (!commands[command]) {
  console.error(`Usage:
  npm run relay -- join <invite-url> --provider codex|claude|cursor --owner <name> [--name <AI name>] [--force]
  npm run relay -- status
  npm run relay -- history [--limit 100]
  npm run relay -- wait [--timeout 25000]
  npm run relay -- listen
  npm run relay -- send <message> [--file <path>]`);
  process.exit(1);
}

commands[command]().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
