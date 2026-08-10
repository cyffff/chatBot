#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const bindingsFile = path.resolve(
  process.env.GROUP_RELAY_CODEX_BINDINGS
    ?? path.join(os.homedir(), ".group-relay", "codex-bindings.json")
);
const stateDir = path.resolve(
  process.env.GROUP_RELAY_CODEX_HOOK_STATE
    ?? path.join(os.homedir(), ".group-relay", "codex-hook-state")
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input || "{}");
}

async function loadBinding(sessionId) {
  const registry = JSON.parse(await fs.readFile(bindingsFile, "utf8"));
  const binding = registry.threads?.[sessionId];
  if (!binding) return null;
  const config = JSON.parse(await fs.readFile(binding.configFile, "utf8"));
  if (config.groupId !== binding.expectedGroupId) {
    throw new Error("Codex binding group does not match its session config; refusing callback.");
  }
  return { binding, config };
}

async function request(config, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (config.email) headers.set("X-Relay-Email", config.email);
  else if (config.memberToken) headers.set("Authorization", `Bearer ${config.memberToken}`);
  if (config.provider) headers.set("X-Relay-Provider", config.provider);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let lastError;
  for (const delay of [0, 300, 1_000, 2_000]) {
    if (delay) await sleep(delay);
    try {
      const response = await fetch(`${config.baseUrl}${pathname}`, { ...options, headers });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Relay returned ${response.status}`);
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function presence(config, status) {
  return request(config, `/api/groups/${config.groupId}/members/me/presence`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}

async function send(config, text, status) {
  const form = new FormData();
  form.set("text", text);
  form.set("status", status);
  return request(config, `/api/groups/${config.groupId}/messages`, { method: "POST", body: form });
}

async function update(config, messageId, text, status) {
  return request(config, `/api/groups/${config.groupId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ text, status, expectedGroupId: config.groupId })
  });
}

function stateFile(sessionId) {
  return path.join(stateDir, `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

async function loadState(sessionId) {
  try {
    return JSON.parse(await fs.readFile(stateFile(sessionId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { turns: {} };
    throw error;
  }
}

async function saveState(sessionId, state) {
  await fs.mkdir(stateDir, { recursive: true });
  const target = stateFile(sessionId);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
}

async function handle(event) {
  const sessionId = event.session_id;
  if (!sessionId) return;
  const resolved = await loadBinding(sessionId).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!resolved) return;
  const { binding, config } = resolved;

  if (event.hook_event_name === "SessionStart") {
    await presence(config, "online");
    return;
  }

  if (event.hook_event_name === "UserPromptSubmit") {
    await presence(config, "busy");
    if (!binding.forwardReplies || !binding.placeholder || !event.turn_id) return;
    const state = await loadState(sessionId);
    if (!state.turns[event.turn_id]) {
      const result = await send(config, "正在处理这个问题，请稍等…", "processing");
      state.turns[event.turn_id] = { placeholderId: result.message.id, completed: false };
      await saveState(sessionId, state);
    }
    return;
  }

  if (event.hook_event_name === "Stop") {
    if (binding.forwardReplies && event.last_assistant_message?.trim() && event.turn_id) {
      const state = await loadState(sessionId);
      const turn = state.turns[event.turn_id] ?? {};
      if (!turn.completed) {
        if (turn.placeholderId) {
          await update(config, turn.placeholderId, event.last_assistant_message.trim(), "complete");
        } else {
          await send(config, event.last_assistant_message.trim(), "complete");
        }
        state.turns[event.turn_id] = { ...turn, completed: true };
        const entries = Object.entries(state.turns).slice(-100);
        state.turns = Object.fromEntries(entries);
        await saveState(sessionId, state);
      }
    }
    await presence(config, "online");
  }
}

try {
  await handle(await stdinJson());
  process.stdout.write("{}\n");
} catch (error) {
  // Hooks must never block a Codex turn because the relay is temporarily unavailable.
  console.error(`Group Relay hook: ${error.message}`);
  process.stdout.write("{}\n");
}
