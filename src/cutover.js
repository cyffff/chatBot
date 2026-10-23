import fs from "node:fs";
import { localeFromAcceptLanguage, translate } from "./i18n.js";

/// 群聊搬到 RMP「AI 协作」时的两个开关,都由部署方的环境变量决定,不设就和以前完全一样。
///
/// 冻结(GROUP_RELAY_FREEZE=1):切换窗口里数据不能再变 —— 所有写请求回 503,读照常,AI 的长轮询
/// 不再派活。在线心跳只改内存,不算写,照常放行:拒掉它,装在各人电脑上的旧 worker 会每两秒重试一次。
///
/// 已搬走(GROUP_RELAY_MOVED_WEB=<RMP 网页地址>):旧链接在浏览器里经一张跳转页送到 RMP 里对应的位置,
/// 接口一律立刻回 410 并说明去哪、AI 该怎么迁过去(长轮询也不挂着:AI 第一眼就该看到这段话)。
/// RMP 只在公司 VPN 内可达,所以跳转页先探一下能不能连上:连得上立刻跳,连不上就告诉人先连 VPN。
/// AI 不能自己迁过去 —— 它要等主人在 RMP「我的 AI」里点「重新连接」把一次性链接发给它,那条链接是凭证。

const enabledValues = new Set(["1", "true", "on", "yes"]);
const disabledValues = new Set(["", "0", "false", "off", "no"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inviteTokenPattern = /^[A-Za-z0-9_-]{8,200}$/;
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/// 冻结期间仍然放行的写:它们只碰内存,不改任何要迁走的数据。
const frozenExemptPaths = [
  /^\/api\/groups\/[^/]+\/members\/me\/presence$/,
  /^\/api\/account\/web-logins$/,
  /^\/api\/web-logins\/[^/]+\/claim$/
];

/// 页面外壳的路由:这些地址在浏览器里打开都要送去 RMP。
const pageRoutes = /^\/(?:|app|index\.html|(?:group|join|transfer|web-login)\/[^/]+)\/?$/;

/// 认得出来的 AI 抓取工具:它们发的是浏览器式 Accept(text/html 在最前面),只靠 Accept 判断会把
/// 给 AI 的文字说明变成一张网页。这些 UA 都不是浏览器,浏览器的 UA 里不会出现它们。
export const agentUserAgents = /claude|codex|cursor|curl|wget|python-requests|httpx|node-fetch|undici|go-http-client|okhttp|axios/i;

export const wantsAgentText = (req) => {
  if (req.query.format === "text") return true;
  if (req.query.format === "html") return false;
  if (agentUserAgents.test(req.get("user-agent") ?? "")) return true;
  return !(req.get("accept") ?? "").includes("text/html");
};

/// 已经装在各人电脑上、没法立刻升级的 worker(macOS 桌面端的桥接、旧版 bin/relay-worker.js)只认
/// 错误文字:里面有这句就停下,并在本机注册表里把自己标成停用 —— 否则每两秒重试一次,永远不停。
/// 新客户端看 code,不靠这句。
const legacyStopNotice = "（旧服务器：not a member of this group here any more）";

const movedKey = "群聊已迁到 RMP「AI 协作」：{0}。RMP 只能在公司 VPN 内访问，请先连接 VPN。";
const frozenKey = "群聊正在迁移到 RMP，现在是只读：可以查看，暂时不能发消息或修改。";
const pageTitleKey = "群聊已迁到 RMP";
const openingKey = "正在打开 RMP…";
const vpnKey = "群聊已迁到 RMP。RMP 只能在公司 VPN 内访问，请先连接 VPN";
const vpnStuckKey = "已连上 VPN 仍停在这里？直接点上面的链接。";
const retryKey = "重试";
const desktopKey = "这个桌面客户端不再需要了：群聊和 AI 都已经在 RMP 里。";
const openInBrowserKey = "在浏览器中打开 RMP";

/// 配错就拒绝启动:冻结开关拼错等于以为冻住了其实没有。
export function parseFlag(value, name = "GROUP_RELAY_FREEZE") {
  if (value === true || value === false) return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (enabledValues.has(text)) return true;
  if (disabledValues.has(text)) return false;
  throw new Error(`Invalid ${name} "${value}" (expected 1 or 0)`);
}

/// 只收 http/https、不带 query 和 #;末尾的 / 去掉,拼路径时不会出现 //。
export function parseBaseUrl(value, name) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid ${name} "${text}" (expected an http(s) URL such as https://rmp.example.com)`);
  }
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password) {
    throw new Error(`Invalid ${name} "${text}" (expected an http(s) URL without query, fragment or credentials)`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/// 映射文件缺了、坏了都不阻止启动:那只是让人落到 RMP 的群聊列表而不是具体那个群,比整站 502 强。
/// 日志只写条数和原因,不写内容 —— 邀请链接是凭证。
function readJson(file, name, warn) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    warn(`[cutover] ${name} not loaded (${error.code ?? error.name}); falling back to the chat list`);
    return null;
  }
}

/// {旧邀请 token: RMP 新邀请链接}。新链接必须在 RMP 网页同一个域名下:拿别的环境导出来的映射
/// 会被整条丢掉,而不是把人送错环境。
export function loadInviteMap(file, web, warn = () => {}) {
  const invites = new Map();
  const raw = readJson(file, "GROUP_RELAY_MOVED_INVITES", warn);
  if (raw === null) return invites;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn("[cutover] GROUP_RELAY_MOVED_INVITES must be a JSON object {oldInviteToken: newJoinUrl}; ignored");
    return invites;
  }
  const origin = new URL(web).origin;
  let skipped = 0;
  for (const [token, target] of Object.entries(raw)) {
    let url = null;
    try {
      url = typeof target === "string" ? new URL(target) : null;
    } catch {
      url = null;
    }
    if (!inviteTokenPattern.test(token) || !url || url.origin !== origin) {
      skipped += 1;
      continue;
    }
    invites.set(token, url.href);
  }
  if (skipped) warn(`[cutover] GROUP_RELAY_MOVED_INVITES: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} (bad token, or link not under ${origin})`);
  return invites;
}

/// 已经迁过去的群 id。RMP 里群的 key 就是原来的群 id,不在名单里的群落到群聊列表。
export function loadMigratedGroups(file, warn = () => {}) {
  const groups = new Set();
  const raw = readJson(file, "GROUP_RELAY_MOVED_GROUPS", warn);
  if (raw === null) return groups;
  if (!Array.isArray(raw)) {
    warn("[cutover] GROUP_RELAY_MOVED_GROUPS must be a JSON array of group ids; ignored");
    return groups;
  }
  let skipped = 0;
  for (const groupId of raw) {
    if (typeof groupId === "string" && uuidPattern.test(groupId)) groups.add(groupId.toLowerCase());
    else skipped += 1;
  }
  if (skipped) warn(`[cutover] GROUP_RELAY_MOVED_GROUPS: skipped ${skipped} value(s) that are not group ids`);
  return groups;
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]
));

/// 内联进 <script> 的字符串:JSON 编码之后再把 < 换掉,值里出现 </script> 也拆不开脚本块。
const scriptString = (value) => JSON.stringify(String(value)).replace(/</g, "\\u003c");

const both = (key, values = []) => (
  `${escapeHtml(translate("zh", key, values))}<span class="en">${escapeHtml(translate("en", key, values))}</span>`
);
const bothInline = (key) => `${escapeHtml(translate("zh", key))} · ${escapeHtml(translate("en", key))}`;

/// 跳转页。中英文同时给(还不知道是谁);不引任何外部资源,脚本和样式都内联。
/// 探测用 no-cors 去取 RMP 的 favicon:只要连得上就会返回(哪怕 404),连不上就抛错或 2.5 秒超时。
/// 连不上时每 5 秒再悄悄探一次,连上 VPN 之后不用点就自己跳过去。
/// 桌面客户端的窗口里不原地跳:窗口里挂着本机 AI 的原生接口,不能交给别的站点;RMP 的登录在内嵌浏览器里
/// 也不可靠。给一个按钮在系统浏览器里打开(两个桌面端都把新窗口请求交给系统浏览器)。
export function interstitialPage({ target, probeUrl }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Group Relay → RMP</title>
<style>
:root { color-scheme: light dark; --bg: #f5f6f8; --card: #fff; --text: #1d2129; --muted: #667085; --accent: #1f6848; --callout: #fff7df; --callout-text: #5c4400; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #14161a; --card: #1e2127; --text: #e8eaed; --muted: #98a2b3; --accent: #6fcf97; --callout: #3a3220; --callout-text: #f3d98b; }
}
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
  background: var(--bg); color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { width: 100%; max-width: 480px; box-sizing: border-box; padding: 28px 24px; border-radius: 16px;
  background: var(--card); box-shadow: 0 8px 30px rgba(0, 0, 0, .08); }
h1 { margin: 0 0 16px; font-size: 22px; line-height: 1.4; color: var(--accent); }
h1 small { display: block; margin-top: 2px; color: var(--muted); font-size: 14px; font-weight: 500; }
p { margin: 0 0 12px; overflow-wrap: anywhere; }
.en { display: block; color: var(--muted); font-size: 14px; }
.hint { padding: 10px 12px; border-radius: 10px; background: var(--callout); color: var(--callout-text); }
.hint .en { color: inherit; opacity: .8; }
a { color: var(--accent); }
button, .button { display: inline-block; margin-top: 4px; padding: 9px 18px; border: 0; border-radius: 10px;
  background: var(--accent); color: #fff; font: inherit; text-decoration: none; cursor: pointer; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(translate("zh", pageTitleKey))}<small>${escapeHtml(translate("en", pageTitleKey))}</small></h1>
<p><a id="target" href="${escapeHtml(target)}">${escapeHtml(target)}</a></p>
<p id="checking">${both(openingKey)}</p>
<div id="offline" hidden>
<p class="hint">${both(vpnKey)}</p>
<p>${both(vpnStuckKey)}</p>
<button id="retry" type="button">${bothInline(retryKey)}</button>
</div>
<div id="desktop" hidden>
<p>${both(desktopKey)}</p>
<p class="hint">${both(vpnKey)}</p>
<a class="button" href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${bothInline(openInBrowserKey)}</a>
</div>
</main>
<script>
(function () {
  var target = ${scriptString(target)};
  var probeUrl = ${scriptString(probeUrl)};
  var retryTimer = null;
  function show(id, visible) { document.getElementById(id).hidden = !visible; }
  var desktop = Boolean(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.relayNative)
    || Boolean(window.chrome && window.chrome.webview)
    || /GroupRelay(Mac|Windows)\\//.test(navigator.userAgent);
  if (desktop) {
    show("checking", false);
    show("desktop", true);
    return;
  }
  function reachable() {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 2500);
    return fetch(probeUrl + "?probe=" + Date.now(), {
      mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal
    }).then(function () { return true; }, function () { return false; })
      .then(function (ok) { clearTimeout(timeout); return ok; });
  }
  // 旧版 Service Worker 和它的页面外壳缓存在这个旧域名下已经没用了,每次经过这里都顺手清一遍
  function cleanUp() {
    var workers = navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(function (list) {
      return Promise.all(list.map(function (registration) { return registration.unregister(); }));
    }) : null;
    var shells = window.caches ? caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) { return caches.delete(name); }));
    }) : null;
    return Promise.all([workers, shells]).catch(function () {});
  }
  function attempt(quiet) {
    clearTimeout(retryTimer);
    if (!quiet) { show("checking", true); show("offline", false); }
    Promise.all([reachable(), cleanUp()]).then(function (results) { return results[0]; }).then(function (ok) {
      if (ok) { location.replace(target); return; }
      show("checking", false);
      show("offline", true);
      retryTimer = setTimeout(function () { attempt(true); }, 5000);
    });
  }
  document.getElementById("retry").addEventListener("click", function () { attempt(false); });
  attempt(false);
})();
</script>
</body>
</html>
`;
}

/// 接替旧版 Service Worker 的退场版本。旧版把所有导航都回缓存里的页面外壳,服务端的跳转页根本
/// 到不了浏览器;这一版装上就接管,清空缓存、注销自己,再把每个打开的窗口按原地址重新打开 ——
/// 那时已经没有 Service Worker 拦着,服务端回跳转页。重新打开失败的窗口退回旧页面认识的
/// 「有新版本」提示,刷新一下效果一样。被替下来的旧版可能还在后台校验、把文件写回它的缓存,
/// 所以窗口重开之后再扫一遍缓存(跳转页自己也会再清一次)。
export const retiringServiceWorker = `// Group Relay has moved to RMP: this worker only retires the old offline shell (retire-1).
const clearCaches = async () => Promise.all((await caches.keys()).map((key) => caches.delete(key)));
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await clearCaches();
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(windows.map((client) => client.navigate(client.url)
      .catch(() => client.postMessage({ type: "shell-updated" }))));
    await clearCaches();
  })());
});
`;

export function createCutover(config = {}) {
  const env = config.env ?? process.env;
  const pick = (name, key) => (config[name] !== undefined ? config[name] : env[key]);
  const log = config.log ?? ((line) => console.log(line));

  const freezeRequested = parseFlag(pick("freeze", "GROUP_RELAY_FREEZE"));
  const web = parseBaseUrl(pick("movedWeb", "GROUP_RELAY_MOVED_WEB"), "GROUP_RELAY_MOVED_WEB");
  const api = parseBaseUrl(pick("movedApi", "GROUP_RELAY_MOVED_API"), "GROUP_RELAY_MOVED_API");
  const invitesFile = String(pick("movedInvites", "GROUP_RELAY_MOVED_INVITES") ?? "").trim();
  const groupsFile = String(pick("movedGroups", "GROUP_RELAY_MOVED_GROUPS") ?? "").trim();
  if (!web && (api || invitesFile || groupsFile)) {
    throw new Error(
      "GROUP_RELAY_MOVED_API, GROUP_RELAY_MOVED_INVITES and GROUP_RELAY_MOVED_GROUPS need GROUP_RELAY_MOVED_WEB; "
      + "without it nothing is redirected"
    );
  }
  const moved = Boolean(web);
  /// 搬走之后接口全部 410,冻结就没有意义了;两个都设时按已搬走处理。
  const frozen = freezeRequested && !moved;
  const invites = moved && invitesFile ? loadInviteMap(invitesFile, web, log) : new Map();
  const groups = moved && groupsFile ? loadMigratedGroups(groupsFile, log) : new Set();

  const chatUrl = moved ? `${web}/collab/chat` : null;
  const movedTo = moved ? { web, api } : null;
  const probeUrl = moved ? `${new URL(web).origin}/favicon.ico` : null;
  const aiMessage = moved
    ? [
      "Group Relay 已经迁移到 RMP（风控管理平台）的「AI 协作」。这台旧服务器不再收发消息，也不会再给你派任务。",
      `新地址：${chatUrl}${api ? `（后端 API：${api}）` : ""}。RMP 只能在公司 VPN 内访问。`,
      `你已经被迁移过去了：在你主人的「我的 AI」（${web}/collab/ai）里，你显示为「待连接」。`,
      "请告诉你的主人：在「我的 AI」里找到你，点「重新连接」，把生成的一次性链接发给你；"
      + "然后按那个链接返回的说明接入（里面有 worker / MCP 的启动命令）。",
      "那个链接是凭证，只能由主人发给你，你没法自己迁过去。不要再重试这台旧服务器。"
    ].join("\n")
    : null;
  const frozenAiMessage = "Group Relay 正在迁移到 RMP，已冻结为只读：现在发不了消息，也不会再给你派任务。"
    + "不要重试写入；迁移完成后，你的主人会在 RMP 里给你新的接入链接。";

  if (moved) {
    log(`[cutover] moved to ${chatUrl}: pages redirect there, /api answers 410; `
      + `${invites.size} invite link(s) and ${groups.size} group(s) mapped`);
  } else if (frozen) {
    log("[cutover] frozen: writes answer 503, reads still work, AI long polls get no new work");
  }

  const isAiClient = (req) => Boolean(req.get("x-relay-provider") || req.query?.provider)
    || agentUserAgents.test(req.get("user-agent") ?? "");
  const prefersText = (req) => req.query?.format === "text"
    || req.accepts(["application/json", "text/plain"]) === "text/plain";
  const locale = (req) => localeFromAcceptLanguage(req.get("accept-language")) ?? "zh";

  /// 旧邀请链接被 AI 抓到:它可能是第一次被拉进这个群,「你已经被迁移过去了」对它不成立。
  /// 新邀请要人登录 RMP 才能用,所以只告诉它交给主人;映射到的新链接和浏览器跳转给出去的是同一条。
  function joinNote(pathname) {
    const join = /^\/join\/([^/]+)\/?$/.exec(pathname);
    if (!join) return "";
    const mapped = invites.get(safeDecode(join[1]));
    return "\n\n如果你以前不在这个群里、是刚被邀请：这条旧邀请在 RMP 里对应的入口是 "
      + `${mapped ?? `${chatUrl}（请邀请你的人在 RMP 里重新发一条邀请）`}。`
      + "新邀请要由你的主人连上 VPN、登录 RMP 后在浏览器里打开加入，再由主人在 RMP 里把你接进群。";
  }

  /// error 是一整句话:老客户端(编译好的桌面端、各人电脑上没升级的 worker 和 MCP)只认这个字段,
  /// 原样显示或交给 AI,所以「去哪、怎么迁」必须写在里面;机器判断看 code。
  function movedBody(req) {
    return {
      error: isAiClient(req) ? `${aiMessage}\n${legacyStopNotice}` : translate(locale(req), movedKey, [chatUrl]),
      code: "moved",
      movedTo,
      message: { zh: translate("zh", movedKey, [chatUrl]), en: translate("en", movedKey, [chatUrl]) },
      aiMessage
    };
  }

  function sendMoved(req, res, { text = prefersText(req) } = {}) {
    res.status(410).set("Cache-Control", "no-store");
    if (text) res.type("text/plain; charset=utf-8").send(`${aiMessage}${joinNote(req.path)}\n`);
    else res.json(movedBody(req));
  }

  function sendFrozen(req, res) {
    res.status(503).set("Cache-Control", "no-store").json({
      error: isAiClient(req) ? frozenAiMessage : translate(locale(req), frozenKey),
      code: "frozen",
      message: { zh: translate("zh", frozenKey), en: translate("en", frozenKey) },
      aiMessage: frozenAiMessage
    });
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  /// 旧地址 → RMP 里对应的位置。query 一律丢掉:旧邀请链接尾巴上带着分享者的 owner/email。
  function targetFor(pathname) {
    const join = /^\/join\/([^/]+)\/?$/.exec(pathname);
    if (join) return invites.get(safeDecode(join[1])) ?? chatUrl;
    const group = /^\/group\/([^/]+)\/?$/.exec(pathname);
    const groupId = group ? safeDecode(group[1]).toLowerCase() : null;
    if (groupId && groups.has(groupId)) return `${chatUrl}/${encodeURIComponent(groupId)}`;
    return chatUrl;
  }

  function relocate(req, res, next) {
    const pathname = req.path;
    const reading = req.method === "GET" || req.method === "HEAD";
    if (pathname === "/health") return next();
    if (pathname === "/service-worker.js" && reading) {
      res.set("Cache-Control", "no-cache, no-store").type("text/javascript; charset=utf-8").send(retiringServiceWorker);
      return;
    }
    if (pathname.startsWith("/api/")) return sendMoved(req, res);
    if (!reading) return next();
    const isPage = pageRoutes.test(pathname);
    if (isPage && wantsAgentText(req)) return sendMoved(req, res, { text: true });
    const navigates = req.get("sec-fetch-mode") === "navigate" || (req.get("accept") ?? "").includes("text/html");
    if (!isPage && !(navigates && !agentUserAgents.test(req.get("user-agent") ?? ""))) return next();
    res.status(200).set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
      .type("html").send(interstitialPage({ target: targetFor(pathname), probeUrl }));
  }

  function middleware(req, res, next) {
    if (moved) return relocate(req, res, next);
    if (frozen && mutatingMethods.has(req.method) && req.path.startsWith("/api/")
      && !frozenExemptPaths.some((pattern) => pattern.test(req.path))) {
      return sendFrozen(req, res);
    }
    next();
  }

  return { middleware, frozen, moved, active: frozen || moved, movedTo, targetFor, aiMessage };
}
