// 本机 agent 的数据安全策略。三个开关默认关闭,关闭时行为与历史完全一致。
// 打开后分别限制:允许访问的目录白名单、是否可提供目录结构、是否可提供本机文件下载。
// 跨平台:目录比较兼容 Mac/Windows/Linux 的分隔符、盘符与大小写不敏感文件系统。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// win32 / darwin 的文件系统默认大小写不敏感,目录归属比较时要按小写对齐,
// 否则同一个目录写成不同大小写会被误判成越界。Linux 保持大小写敏感。
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function truthy(value) {
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

// 支持 ~ 展开;白名单里写 ~/knowledge 比写死绝对路径更省心,也更跨机器。
function expandHome(entry) {
  if (entry === "~") return os.homedir();
  if (entry.startsWith("~/") || entry.startsWith("~\\")) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

// 白名单用系统原生分隔符切分(: 于 POSIX、; 于 Windows),这样一份配置在各平台都能直接读。
function parseAllowedDirs(raw) {
  return String(raw ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(expandHome(entry)));
}

export function loadSecurityConfig(env = process.env) {
  return {
    restrictDirs: truthy(env.GROUP_RELAY_RESTRICT_DIRS),
    allowedDirs: parseAllowedDirs(env.GROUP_RELAY_ALLOWED_DIRS),
    noDirListing: truthy(env.GROUP_RELAY_NO_DIR_LISTING),
    noFileDownload: truthy(env.GROUP_RELAY_NO_FILE_DOWNLOAD)
  };
}

function foldCase(value) {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

// child 是否落在 root 之内(含 root 自身)。用 path.relative 判断,
// 大小写不敏感平台先折叠大小写再比,避免 C:\Repo 与 c:\repo 被判成两处。
function isWithin(child, root) {
  const rel = path.relative(foldCase(root), foldCase(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

// 尽量解析真实路径以挡住软链越权(白名单里放一个指向 /etc 的软链就绕过了)。
// 路径还不存在时,退回到最近一层存在的祖先做解析,再拼回末段。
async function canonicalize(target) {
  try {
    return await fs.realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return path.resolve(target);
    try {
      return path.join(await fs.realpath(parent), path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
}

// 目录白名单校验。开关关闭时直接放行(保持现状);打开但白名单为空时默认全拒,
// 避免「开了限制却什么都没配」被误解成不限制。供 filePath 与 codex 工作区共用。
export async function assertWithinAllowedDirs(target, config = loadSecurityConfig()) {
  if (!config.restrictDirs) return;
  if (config.allowedDirs.length === 0) {
    throw new Error(
      "数据安全策略已开启目录白名单(GROUP_RELAY_RESTRICT_DIRS),"
      + "但 GROUP_RELAY_ALLOWED_DIRS 为空:默认拒绝所有本机路径访问。"
    );
  }
  const resolved = await canonicalize(path.resolve(target));
  const roots = await Promise.all(config.allowedDirs.map((dir) => canonicalize(dir)));
  if (!roots.some((root) => isWithin(resolved, root))) {
    throw new Error(
      `数据安全策略拒绝访问:${path.resolve(target)} 不在允许的目录白名单内。`
      + `允许的目录:${config.allowedDirs.join(", ")}`
    );
  }
}

// group_send_file 用 filePath 附本机文件时的策略校验:
// 1) 禁止文件下载 → 直接拒绝 filePath(改为读内容后内联发送);
// 2) 禁止提供目录结构 → 拒绝把目录当文件发出;
// 3) 目录白名单 → 路径必须落在清单内。
export async function assertFilePathSendable(filePath, config = loadSecurityConfig()) {
  if (config.noFileDownload) {
    throw new Error(
      "数据安全策略已禁止本机文件下载(GROUP_RELAY_NO_FILE_DOWNLOAD):不能把本机文件作为附件发出。"
      + "如需分享内容,请读取文件后用文字/内联 content 回复(仅允许用于 AI 读取知识内容)。"
    );
  }
  const resolved = path.resolve(filePath);
  if (config.noDirListing) {
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat?.isDirectory()) {
      throw new Error(
        "数据安全策略已禁止提供目录结构(GROUP_RELAY_NO_DIR_LISTING):不能把目录作为文件发出。"
      );
    }
  }
  await assertWithinAllowedDirs(resolved, config);
}
