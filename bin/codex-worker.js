#!/usr/bin/env node
/// 历史入口:`npm run worker:codex`。真正的实现搬到 bin/relay-worker.js 了(那份三个 provider
/// 通吃、跨平台),这里只保留旧参数名做转发 —— 提示词和执行档位从此只有一份,不会再各自漂移。
/// 新用法是 `npm run relay -- worker --session <id>` 或直接 `node bin/relay-worker.js`。
import fs from "node:fs/promises";
import path from "node:path";
import { runWorker, stderrLog } from "./relay-worker.js";

const args = process.argv.slice(2);

function option(name, fallback = null) {
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

const sessionId = option("session") ?? process.env.GROUP_RELAY_SESSION_ID;
const safeSessionId = sessionId?.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
const configFile = path.resolve(
  process.env.GROUP_RELAY_AGENT_CONFIG
    ?? (safeSessionId ? `.group-relay-sessions/${safeSessionId}.json` : ".group-relay-agent.json")
);
const codexBin = option("codex-bin", process.env.CODEX_BIN ?? null);
const model = option("model", process.env.GROUP_RELAY_CODEX_MODEL ?? null);
const once = flag("once");
// 旧的按总耗时超时参数还收着,但不再用它硬杀:现在按「进程树是否还在动」判定(见 relay-worker.js)。
option("codex-timeout");

if (args.length) {
  console.error(`Unknown arguments: ${args.join(" ")}`);
  process.exit(2);
}

async function saveConfig(config) {
  const temporary = `${configFile}.tmp`;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, configFile);
  await fs.chmod(configFile, 0o600);
}

const config = await fs.readFile(configFile, "utf8").then(JSON.parse).catch((error) => {
  console.error(error.code === "ENOENT"
    ? `No AI session found at ${configFile}. Run relay join first.`
    : error.message);
  process.exit(1);
});

if (config.provider !== "codex") {
  console.error(
    `Session provider is ${config.provider}; codex-worker only supports codex.`
    + " Use: npm run relay -- worker --session <id>"
  );
  process.exit(1);
}

const result = await runWorker({
  config,
  configFile,
  saveConfig,
  once,
  model,
  agentBin: codexBin,
  log: stderrLog
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
console.log(JSON.stringify(result));
