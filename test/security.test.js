import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadSecurityConfig,
  assertWithinAllowedDirs,
  assertFilePathSendable
} from "../bin/security.js";

// 三个开关默认全关,行为与历史一致:任何路径都放行、filePath 照发。
test("defaults leave every path accessible", async () => {
  const config = loadSecurityConfig({});
  assert.deepEqual(config, {
    restrictDirs: false,
    allowedDirs: [],
    noDirListing: false,
    noFileDownload: false
  });
  await assertWithinAllowedDirs("/etc/passwd", config);
  await assertWithinAllowedDirs("C:/Windows/System32", config);
});

test("env parsing reads booleans and OS path lists", () => {
  const roots = [path.resolve("/a/one"), path.resolve("/a/two")].join(path.delimiter);
  const config = loadSecurityConfig({
    GROUP_RELAY_RESTRICT_DIRS: "on",
    GROUP_RELAY_ALLOWED_DIRS: roots,
    GROUP_RELAY_NO_DIR_LISTING: "1",
    GROUP_RELAY_NO_FILE_DOWNLOAD: "true"
  });
  assert.equal(config.restrictDirs, true);
  assert.equal(config.noDirListing, true);
  assert.equal(config.noFileDownload, true);
  assert.deepEqual(config.allowedDirs, [path.resolve("/a/one"), path.resolve("/a/two")]);
});

test("whitelist confines access to allowed directories", async (t) => {
  const allowed = await fs.mkdtemp(path.join(os.tmpdir(), "relay-allowed-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "relay-outside-"));
  t.after(() => Promise.all([
    fs.rm(allowed, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true })
  ]));
  const config = loadSecurityConfig({
    GROUP_RELAY_RESTRICT_DIRS: "on",
    GROUP_RELAY_ALLOWED_DIRS: allowed
  });
  const inside = path.join(allowed, "sub", "notes.md");
  await fs.mkdir(path.dirname(inside), { recursive: true });
  await fs.writeFile(inside, "hi");

  await assertWithinAllowedDirs(inside, config);
  await assertWithinAllowedDirs(allowed, config);
  await assert.rejects(
    () => assertWithinAllowedDirs(path.join(outside, "secret.txt"), config),
    /目录白名单/
  );
  // 白名单前缀相同但不是子目录,不能被误判成命中(allowed vs allowed-evil)。
  await assert.rejects(
    () => assertWithinAllowedDirs(`${allowed}-evil/x`, config),
    /目录白名单/
  );
});

test("restrict with an empty allow-list denies everything", async () => {
  const config = loadSecurityConfig({ GROUP_RELAY_RESTRICT_DIRS: "on" });
  await assert.rejects(() => assertWithinAllowedDirs(os.homedir(), config), /GROUP_RELAY_ALLOWED_DIRS 为空/);
});

test("no-file-download blocks attaching any local file", async () => {
  const config = loadSecurityConfig({ GROUP_RELAY_NO_FILE_DOWNLOAD: "on" });
  await assert.rejects(
    () => assertFilePathSendable("/any/where/report.md", config),
    /禁止本机文件下载/
  );
});

test("no-dir-listing blocks sending a directory as a file", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-dir-"));
  const file = path.join(dir, "note.txt");
  await fs.writeFile(file, "content");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadSecurityConfig({ GROUP_RELAY_NO_DIR_LISTING: "on" });
  await assert.rejects(() => assertFilePathSendable(dir, config), /禁止提供目录结构/);
  // 真正的文件仍可发送(该开关只挡目录)。
  await assertFilePathSendable(file, config);
});
