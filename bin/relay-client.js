#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLocale, translate } from "../src/i18n.js";

const args = process.argv.slice(2);
const command = args.shift();

function globalOption(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

const codexThreadId = process.env.CODEX_THREAD_ID ?? null;
const sessionId = globalOption("session") ?? process.env.GROUP_RELAY_SESSION_ID ?? codexThreadId;
const connectionName = globalOption("connection") ?? null;
const safeSessionId = sessionId?.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
const configFile = path.resolve(
  process.env.GROUP_RELAY_AGENT_CONFIG
    ?? (safeSessionId ? `.group-relay-sessions/${safeSessionId}.json` : ".group-relay-agent.json")
);
const presenceFile = `${configFile}.presence`;
const codexBindingsFile = path.resolve(
  process.env.GROUP_RELAY_CODEX_BINDINGS
    ?? path.join(os.homedir(), ".group-relay", "codex-bindings.json")
);
const localWorkersFile = path.resolve(
  process.env.GROUP_RELAY_LOCAL_WORKERS
    ?? path.join(os.homedir(), ".group-relay", "local-workers.json")
);

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
  if (connectionName) return loadCodexConnection(connectionName);
  try {
    return JSON.parse(await fs.readFile(configFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No agent config found at ${configFile}. Run "npm run relay -- join ..." first.`);
    }
    throw error;
  }
}

async function loadCodexConnection(name) {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const source = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  const lines = source.split("\n");
  const marker = `[mcp_servers.${name}]`;
  const start = lines.indexOf(marker);
  if (start < 0) throw new Error(`Codex MCP connection "${name}" was not found.`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("[") && !lines[index].startsWith(`[mcp_servers.${name}.`)) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n");
  const value = (key) => section.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`))?.[1];
  const config = {
    baseUrl: value("GROUP_RELAY_URL")?.replace(/\/$/, ""),
    groupId: value("GROUP_RELAY_GROUP_ID"),
    email: value("GROUP_RELAY_EMAIL"),
    provider: value("GROUP_RELAY_PROVIDER"),
    connectionName: name,
    cursor: null
  };
  if (!config.baseUrl || !config.groupId || !(config.email || config.memberToken)) {
    throw new Error(`Codex MCP connection "${name}" is missing Group Relay settings.`);
  }
  return config;
}

async function saveConfig(config) {
  const temp = `${configFile}.tmp`;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, configFile);
  await fs.chmod(configFile, 0o600);
}

async function updateCodexBinding(threadId, config, options = {}) {
  let registry = { version: 1, threads: {} };
  try {
    registry = JSON.parse(await fs.readFile(codexBindingsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  registry.version = 1;
  registry.threads ??= {};
  registry.threads[threadId] = {
    configFile,
    expectedGroupId: config.groupId,
    sessionId: config.sessionId ?? sessionId,
    forwardReplies: options.forwardReplies === true,
    placeholder: options.placeholder === true,
    boundAt: new Date().toISOString()
  };
  const temporary = `${codexBindingsFile}.tmp`;
  await fs.mkdir(path.dirname(codexBindingsFile), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, codexBindingsFile);
  await fs.chmod(codexBindingsFile, 0o600);
  return registry.threads[threadId];
}

async function updateLocalWorker(config, enabled) {
  let registry = { version: 1, workers: {} };
  try {
    registry = JSON.parse(await fs.readFile(localWorkersFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  registry.version = 1;
  registry.workers ??= {};
  const workerId = config.sessionId ?? sessionId ?? config.memberId;
  if (!workerId) throw new Error("The AI session has no stable worker id.");
  if (enabled) {
    registry.workers[workerId] = {
      configFile,
      groupId: config.groupId,
      provider: config.provider,
      enabled: true,
      updatedAt: new Date().toISOString()
    };
  } else {
    delete registry.workers[workerId];
  }
  const temporary = `${localWorkersFile}.tmp`;
  await fs.mkdir(path.dirname(localWorkersFile), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, localWorkersFile);
  await fs.chmod(localWorkersFile, 0o600);
  return { workerId, enabled, registryFile: localWorkersFile };
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
  // 身份是 email(+provider)。迁移前建的 session 配置里只有 memberToken,
  // 这时退回旧头让服务端的宽限期认它,而不是直接失败。
  if (config.email) headers.set("X-Relay-Email", config.email);
  else if (config.memberToken) headers.set("Authorization", `Bearer ${config.memberToken}`);
  if (config.provider) headers.set("X-Relay-Provider", config.provider);
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
  const hookReplies = flag("hook-replies");
  const hookPlaceholder = flag("hook-placeholder");
  const background = flag("background");
  const provider = option("provider");
  const ownerName = option("owner");
  // AI 用主人的 email 作为身份;服务端不再发成员 token。
  const email = option("email") ?? process.env.GROUP_RELAY_EMAIL;
  const name = option("name", providerName(provider));
  const agentBin = option("agent-bin");
  const model = option("model");
  const workspace = option("workspace");
  if (!inviteUrl || !provider || !ownerName || !email || !["codex", "claude", "cursor", "opencode"].includes(provider)) {
    throw new Error(
      "Usage: npm run relay -- join <invite-url> --session <session-id> --provider codex|claude|cursor|opencode --owner <name> --email <owner-email> [--name <AI name>]"
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
      let codexBinding = null;
      if (provider === "codex" && codexThreadId) {
        codexBinding = await updateCodexBinding(codexThreadId, previous, {
          forwardReplies: hookReplies || hookPlaceholder,
          placeholder: hookPlaceholder
        });
      }
      const localWorker = background ? await updateLocalWorker(previous, true) : null;
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
        codexBinding: codexBinding ? {
          threadId: codexThreadId,
          forwardReplies: codexBinding.forwardReplies,
          placeholder: codexBinding.placeholder
        } : null,
        localWorker,
        configFile
      }, null, 2));
      return;
    } catch (error) {
      if (error.message !== "not a member of this group") throw error;
      previous = null;
    }
  }
  const joinResponse = await request(
    { baseUrl },
    `/api/invites/${encodeURIComponent(match[1])}/join`,
    {
      method: "POST",
      body: JSON.stringify({ email, name, type: "ai", provider })
    }
  );
  const config = {
    baseUrl,
    groupId: joinResponse.group.id,
    memberId: joinResponse.member.id,
    email,
    memberName: name,
    provider,
    ownerName,
    sessionId,
    cursor: null,
    workspacePath: path.resolve(workspace ?? process.cwd()),
    ...(agentBin ? { agentBin: path.resolve(agentBin) } : {}),
    ...(model ? { model } : {})
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
  const localWorker = background ? await updateLocalWorker(config, true) : null;
  let codexBinding = null;
  if (provider === "codex" && codexThreadId) {
    codexBinding = await updateCodexBinding(codexThreadId, config, {
      forwardReplies: hookReplies || hookPlaceholder,
      placeholder: hookPlaceholder
    });
  }
  /// 上线播报会永久留在聊天记录里,按主人的语言写(拿不到偏好就中文)。
  const { provider: _ownerView, ...ownerIdentity } = config;
  const locale = normalizeLocale(
    (await request(ownerIdentity, "/api/account").catch(() => null))?.account?.locale
  ) ?? "zh";
  const online = await sendText(
    config,
    translate(locale, "{0} 已加入群聊，正在监听消息。", [`${ownerName}’s ${name}`])
  );
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
    codexBinding: codexBinding ? {
      threadId: codexThreadId,
      forwardReplies: codexBinding.forwardReplies,
      placeholder: codexBinding.placeholder
    } : null,
    localWorker,
    headlessWorker: background ? await headlessHint(config) : null,
    configFile
  }, null, 2));
}

/// `--background` 只是往本机注册表写一条,真正执行要么靠桌面客户端每十秒读一次那份清单,
/// 要么靠 `relay worker` 这个常驻进程。检测不到桌面客户端时得说清下一步 —— 否则 AI 以为
/// 自己已经在线,群里 @ 它却永远没人应。
async function headlessHint(config) {
  if (process.platform === "darwin") {
    const installed = await fs.stat("/Applications/Group Relay.app").then(() => true).catch(() => false);
    if (installed) return null;
  }
  const registry = await fs.readFile(localWorkersFile, "utf8").then(JSON.parse).catch(() => null);
  const desktopRunning = Object.keys(registry?.workers ?? {}).some((id) => id.startsWith("desktop-"));
  if (desktopRunning) return null;
  return "这台机器上没有检测到 Group Relay 桌面客户端,注册表里的条目不会有人执行。"
    + `请让这个进程常驻:npm run relay -- worker --session ${config.sessionId ?? sessionId}`
    + "(前台运行即可;要后台可以配 systemd / nohup / Windows 计划任务)。";
}

async function backgroundWorker() {
  const config = await loadConfig();
  if (!config.provider || !["codex", "claude", "cursor"].includes(config.provider)) {
    // 桌面客户端的桥接只认前三个;opencode 目前靠 `relay worker` 常驻(见 README)。
    throw new Error(
      config.provider === "opencode"
        ? "opencode 暂不支持桌面客户端的后台桥接，请用 npm run relay -- worker --session <id> 常驻。"
        : "Only Codex, Claude and Cursor AI sessions can run in the Mac background bridge."
    );
  }
  const disable = flag("disable");
  const result = await updateLocalWorker(config, !disable);
  console.log(JSON.stringify({
    ...result,
    provider: config.provider,
    groupId: config.groupId,
    headlessWorker: disable ? null : await headlessHint(config)
  }, null, 2));
}

async function desktopWorker() {
  const config = await loadConfig();
  if (!config.groupId) throw new Error("This session has no group id; re-run join.");
  if (!config.email || !config.provider) {
    throw new Error("This session predates email identity; re-run join to get an owner email.");
  }
  const enabled = flag("enable") ? true : !flag("disable");
  const memberId = `ai:${config.email.toLowerCase()}:${config.provider}`;
  // 用人的身份发(不带 X-Relay-Provider):这是主人对自己机器上进程的开关。
  const { provider: _provider, ...asOwner } = config;
  const result = await request(asOwner, `/api/groups/${config.groupId}/members/${memberId}/desktop-worker`, {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
  // 关掉之后本机那份清单也顺手清一下,不用等客户端下一次同步。
  await updateLocalWorker(config, enabled).catch(() => null);
  console.log(JSON.stringify({
    groupId: config.groupId,
    provider: config.provider,
    desktopWorkerEnabled: enabled,
    member: result.member
  }, null, 2));
}

/// 跨平台常驻:自己就是那个执行体,不再依赖桌面客户端来拉起 worker。
/// Linux/服务器/纯命令行 Windows 上「把邀请链接发给自己的 AI」之后,靠这条命令保持在线。
async function worker() {
  const config = await loadConfig();
  const once = flag("once");
  const model = option("model");
  const agentBin = option("agent-bin");
  const logFile = option("log");
  const { runWorker, fileLogger, stderrLog } = await import("./relay-worker.js");
  const log = logFile ? await fileLogger(logFile) : stderrLog;
  // 同一台机器上如果桌面客户端也在跑同一个群的 worker,两边会各回一次(服务端已按「先来先领」
  // 去重,但白烧一份额度)。提醒一句,并给出关掉那一个的办法。
  const registry = await fs.readFile(localWorkersFile, "utf8").then(JSON.parse).catch(() => null);
  const desktopSame = Object.entries(registry?.workers ?? {})
    .find(([id, entry]) => id.startsWith("desktop-") && entry?.groupId === config.groupId);
  if (desktopSame) {
    log(`注意:本机桌面客户端也在跑这个群的 worker(${desktopSame[0]})。`
      + `要只留命令行这一个,执行 npm run relay -- desktop-worker --session <id> --disable`);
  }
  const result = await runWorker({
    config,
    configFile,
    saveConfig,
    once,
    model,
    agentBin,
    log,
    // 不在群里了就把本机注册表那条清掉,别让任何人再把它拉起来。
    onMembershipGone: () => updateLocalWorker(config, false).catch(() => null)
  });
  console.log(JSON.stringify({ ...result, groupId: config.groupId, provider: config.provider }, null, 2));
}

async function bindCodex() {
  const config = await loadConfig();
  const threadId = option("thread-id", codexThreadId);
  const forwardReplies = flag("forward-replies");
  const placeholder = flag("placeholder");
  if (!threadId) {
    throw new Error("No Codex thread id found. Run inside Codex Mac or pass --thread-id.");
  }
  if (config.provider !== "codex") {
    throw new Error(`Cannot bind Codex hooks to provider ${config.provider ?? "unknown"}.`);
  }
  const binding = await updateCodexBinding(threadId, config, {
    forwardReplies: forwardReplies || placeholder,
    placeholder
  });
  console.log(JSON.stringify({
    bound: true,
    threadId,
    sessionId: binding.sessionId,
    groupId: binding.expectedGroupId,
    forwardReplies: binding.forwardReplies,
    placeholder: binding.placeholder,
    bindingsFile: codexBindingsFile
  }, null, 2));
}

async function sendText(config, text, files = [], { status = "complete", replyTo } = {}) {
  if (!text && files.length === 0) throw new Error("A message or file is required");
  const form = new FormData();
  if (text) form.set("text", text);
  form.set("status", status);
  if (replyTo) form.set("replyTo", replyTo);
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
  const expectedGroupId = option("expected-group");
  const status = option("status", "complete");
  const replyTo = option("reply-to");
  if (!["processing", "complete", "failed"].includes(status)) {
    throw new Error("--status must be processing, complete or failed.");
  }
  if (connectionName && !expectedGroupId) {
    throw new Error("--expected-group is required when sending through a named connection.");
  }
  if (expectedGroupId && expectedGroupId !== config.groupId) {
    throw new Error(
      `Refusing to send: connection "${connectionName ?? sessionId ?? "default"}" targets `
      + `${config.groupId}, not expected group ${expectedGroupId}.`
    );
  }
  const files = [];
  while (args.includes("--file")) {
    const index = args.indexOf("--file");
    files.push(path.resolve(args[index + 1]));
    args.splice(index, 2);
  }
  const text = args.join(" ").trim();
  const result = await sendText(config, text, files, { status, replyTo });
  await reportPresence(config, status === "processing" ? "busy" : "online", {
    persist: !connectionName
  });
  console.log(JSON.stringify(result, null, 2));
}

async function update() {
  const config = await loadConfig();
  const messageId = option("message");
  const expectedGroupId = option("expected-group");
  const status = option("status", "complete");
  if (!messageId) throw new Error("--message is required.");
  if (connectionName && !expectedGroupId) {
    throw new Error("--expected-group is required when updating through a named connection.");
  }
  if (expectedGroupId && expectedGroupId !== config.groupId) {
    throw new Error(
      `Refusing to update: connection "${connectionName ?? sessionId ?? "default"}" targets `
      + `${config.groupId}, not expected group ${expectedGroupId}.`
    );
  }
  if (!["processing", "complete", "failed"].includes(status)) {
    throw new Error("--status must be processing, complete or failed.");
  }
  const text = args.join(" ").trim();
  if (!text) throw new Error("Updated message text is required.");
  const result = await request(config, `/api/groups/${config.groupId}/messages/${messageId}`, {
    method: "PATCH",
    retryNetwork: true,
    body: JSON.stringify({ text, status, expectedGroupId })
  });
  await reportPresence(config, status === "processing" ? "busy" : "online", {
    persist: !connectionName
  });
  console.log(JSON.stringify(result, null, 2));
}

/// 读也要对齐群。写(send/update)一直要求 --expected-group,读却随便读 —— 于是 AI 拿着一个
/// 绑到 B 群的连接去查历史,再拿 B 群的内容回答 A 群的问题(实测出现过的串群)。
/// 命名连接下必须显式说明「我以为我在哪个群」;session 模式给了就校验。
function assertExpectedGroup(config) {
  const expected = option("expected-group");
  if (connectionName && !expected) {
    throw new Error("--expected-group is required when reading through a named connection.");
  }
  if (expected && expected !== config.groupId) {
    throw new Error(
      `Refusing to read: ${connectionName ? `connection "${connectionName}"` : "this session"} is bound to `
      + `${config.groupId}, not expected group ${expected}. 不要拿别的群的历史来回答这里的问题。`
    );
  }
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
  assertExpectedGroup(config);
  const timeoutMs = Math.min(Math.max(Number(option("timeout", "25000")), 1000), 30000);
  await reportPresence(config, await readPresenceStatus(), { persist: false });
  console.log(JSON.stringify(await waitOnce(config, timeoutMs), null, 2));
}

async function listen() {
  const config = await loadConfig();
  assertExpectedGroup(config);
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
  console.log(JSON.stringify(await reportPresence(config, status, { persist: !connectionName }), null, 2));
}

async function history() {
  const config = await loadConfig();
  assertExpectedGroup(config);
  const limit = Math.min(Math.max(Number(option("limit", "100")), 1), 500);
  const after = option("after");
  const query = new URLSearchParams({ limit: String(limit), routed: "1" });
  if (after) query.set("after", after);
  const [result, groupResult] = await Promise.all([
    request(config, `/api/groups/${config.groupId}/messages?${query}`),
    request(config, `/api/groups/${config.groupId}`)
  ]);
  console.log(JSON.stringify({
    connection: connectionName,
    group: { id: groupResult.group.id, name: groupResult.group.name },
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

/// 反馈工单只收 AI 提的,所以这个命令归 AI 用:人把想法讲给你,你润色成
/// 「问题 + 期望行为」再提。--for 写清是替谁提的,实现的人需要知道最初是谁要的。
async function feedback() {
  const config = await loadConfig();
  const title = option("title");
  const onBehalfOf = option("for");
  const body = args.join(" ").trim();
  if (!title || !body) {
    throw new Error("Usage: npm run relay -- feedback --session <id> --title <标题> [--for <谁要的>] <润色后的正文>");
  }
  const result = await request(config, "/api/feedback", {
    method: "POST",
    body: JSON.stringify({
      title,
      body,
      onBehalfOf,
      groupId: config.groupId,
      sourceMessageId: option("source-message")
    })
  });
  console.log(JSON.stringify(result, null, 2));
}

const commands = {
  join,
  send,
  update,
  feedback,
  wait,
  listen,
  history,
  status,
  presence,
  background: backgroundWorker,
  worker,
  "desktop-worker": desktopWorker,
  "bind-codex": bindCodex
};

if (!commands[command]) {
  console.error(`Usage:
  npm run relay -- join <invite-url> --session <session-id> --provider codex|claude|cursor|opencode --owner <name> --email <owner-email> [--name <AI name>] [--workspace <path>] [--model <model>] [--agent-bin <path>] [--force] [--background] [--hook-replies] [--hook-placeholder]
  npm run relay -- bind-codex --session <session-id> [--thread-id <Codex thread id>] [--forward-replies] [--placeholder]
  npm run relay -- worker --session <session-id> [--once] [--model <model>] [--agent-bin <path>] [--log <file>]
  npm run relay -- background --session <session-id> [--disable]
  npm run relay -- desktop-worker --session <session-id> [--disable|--enable]
  npm run relay -- status --session <session-id>
  npm run relay -- history --session <session-id> [--after <message-id>] [--limit 100] [--expected-group <group-id>]
  npm run relay -- wait --session <session-id> [--timeout 25000]
  npm run relay -- listen --session <session-id>
  npm run relay -- presence --session <session-id> --status online|busy
  npm run relay -- feedback --session <session-id> --title <标题> [--for <谁要的>] <润色后的正文>
  npm run relay -- send --session <session-id> [--status processing|complete|failed] <message> [--file <path>]
  npm run relay -- update --session <session-id> --message <message-id> [--status processing|complete|failed] <message>
  npm run relay -- history --connection <mcp-name> --expected-group <group-id> [--after <message-id>] [--limit 100]
  npm run relay -- send --connection <mcp-name> --expected-group <group-id> [--status processing|complete|failed] <message> [--file <path>]
  npm run relay -- update --connection <mcp-name> --expected-group <group-id> --message <message-id> [--status processing|complete|failed] <message>`);
  process.exit(1);
}

commands[command]().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
