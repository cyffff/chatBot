#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.join(here, "codex-hook.js");
const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
const hooksFile = path.join(codexHome, "hooks.json");
const command = `node ${JSON.stringify(hookScript)}`;

let document = { description: "Local Codex lifecycle hooks.", hooks: {} };
try {
  document = JSON.parse(await fs.readFile(hooksFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
document.hooks ??= {};

for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
  document.hooks[event] ??= [];
  const alreadyInstalled = document.hooks[event].some((group) => (
    group.hooks?.some((hook) => hook.command?.includes("/bin/codex-hook.js"))
  ));
  if (!alreadyInstalled) {
    document.hooks[event].push({
      hooks: [{ type: "command", command, timeout: 15, statusMessage: "Syncing Group Relay" }]
    });
  }
}

await fs.mkdir(codexHome, { recursive: true });
try {
  await fs.copyFile(hooksFile, `${hooksFile}.bak`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const temporary = `${hooksFile}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
await fs.rename(temporary, hooksFile);
await fs.chmod(hooksFile, 0o600);
console.log(`Installed Group Relay hooks in ${hooksFile}`);
console.log("Restart Codex, open /hooks, and trust the three new command hooks.");
