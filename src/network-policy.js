import net from "node:net";
import { localeFromAcceptLanguage, translate } from "./i18n.js";

/// 访问防火墙。服务没有登录(email 就是身份),公网地址一旦外泄,任何人都能读群、冒名发消息,
/// 还能把任务派给各人电脑上的 AI worker,所以在所有路由之前加一道按来源地址放行的闸,外加限流。
///
/// 来源地址只认 Cloudflare 隧道带进来的 CF-Connecting-IP。服务只监听回环,外部流量全部经隧道
/// 进来:「对端是回环 + 带 CF 头」是外部请求,「对端是回环 + 什么头都没有」是本机自己在访问
/// (部署脚本探活、测试),放行;「对端是回环 + 带了别的代理头却没有 CF-Connecting-IP」说明
/// 隧道的行为变了,宁可拒绝也不当成本机放行。
///
/// 做不了「只有连了公司 VPN 才能访问」:公司 VPN 是分流模式,去隧道的流量不走 VPN,服务端看到
/// 的永远是各人自己的宽带出口,认不出谁连了 VPN。所以这里只做国家 / IP 白名单和限流。

const modes = new Set(["off", "report", "enforce"]);
const deniedKey = "这个服务只对内部成员开放，当前网络不在允许范围内。";
/// 被拦的人该做什么。判断依据始终是来源地址,这句只是引导 —— 分流 VPN 连上之后出口地址
/// 不一定会变,所以运营方还可以用 GROUP_RELAY_NETWORK_HINT 补一句「连上仍被拦怎么办」。
const vpnPromptKey = "请先连接公司 VPN 后重试";
const rateLimitedKey = "请求过于频繁，请稍后再试。";

const isLoopback = (address) => /^(127\.|::1$|::ffff:127\.)/i.test(String(address ?? ""));

export function normalizeAddress(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!net.isIP(text)) return null;
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped && net.isIPv4(mapped[1]) ? mapped[1] : text;
}

/// 配错一项就整体拒绝启动:enforce 下悄悄丢掉一条等于把人锁在门外。
export function parseCidrList(value) {
  const list = new net.BlockList();
  let count = 0;
  for (const entry of String(value ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const [host, prefix, extra] = entry.split("/");
    const family = net.isIPv4(host) ? "ipv4" : net.isIPv6(host) ? "ipv6" : null;
    const limit = family === "ipv4" ? 32 : 128;
    const prefixOk = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= limit);
    if (!family || extra !== undefined || !prefixOk) {
      throw new Error(`Invalid network entry "${entry}" (expected an IP or CIDR such as 203.0.113.0/24)`);
    }
    if (prefix === undefined) list.addAddress(host, family);
    else list.addSubnet(host, Number(prefix), family);
    count += 1;
  }
  return { list, count };
}

export function parseCountries(value) {
  const codes = new Set();
  for (const entry of String(value ?? "").split(/[\s,;]+/).filter(Boolean)) {
    if (!/^[a-z]{2}$/i.test(entry)) {
      throw new Error(`Invalid country code "${entry}" (expected ISO 3166-1 alpha-2, for example AE)`);
    }
    codes.add(entry.toUpperCase());
  }
  return codes;
}

/// "600/10" = 每个来源地址每 10 秒最多 600 个请求。false / 空 / off 表示不限。
export function parseRateLimit(value) {
  if ([false, null, undefined, "", "off"].includes(value)) return null;
  const match = String(value).trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) {
    throw new Error(`Invalid rate limit "${value}" (expected requests/seconds, for example 600/10)`);
  }
  return { max: Number(match[1]), windowMs: Number(match[2]) * 1000 };
}

/// 固定窗口计数。限流只用来挡住洪水,不追求精确;窗口过期的条目按需清理,
/// 另设硬上限,地址再多也不会把内存撑爆。
function createRateLimiter({ max, windowMs }, clock) {
  const windows = new Map();
  let nextSweep = clock() + windowMs * 6;
  return {
    hit(address) {
      const now = clock();
      if (now >= nextSweep || windows.size > 50_000) {
        for (const [key, entry] of windows) {
          if (entry.resetAt <= now || windows.size > 50_000) windows.delete(key);
        }
        nextSweep = now + windowMs * 6;
      }
      let entry = windows.get(address);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        windows.set(address, entry);
      }
      entry.count += 1;
      if (entry.count <= max) return null;
      return { retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)), first: entry.count === max + 1 };
    }
  };
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]
));

/// 中英文同时给:拒绝页面面对的是还没通过校验的访客,没法按账号偏好选语言。
/// 页面不带脚本、不引外部资源,服务被拦的时候它自己也能完整显示。
function noticePage({ address, hint }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Group Relay</title>
<style>
:root { color-scheme: light dark; --bg: #f5f6f8; --card: #fff; --text: #1d2129; --muted: #667085; --accent: #b42318; --callout: #fdecea; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #14161a; --card: #1e2127; --text: #e8eaed; --muted: #98a2b3; --accent: #f97066; --callout: #3b2220; }
}
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
  background: var(--bg); color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { width: 100%; max-width: 460px; box-sizing: border-box; padding: 28px 24px; border-radius: 16px;
  background: var(--card); box-shadow: 0 8px 30px rgba(0, 0, 0, .08); }
h1 { margin: 0 0 16px; font-size: 22px; line-height: 1.4; color: var(--accent); }
h1 small { display: block; margin-top: 2px; color: var(--muted); font-size: 14px; font-weight: 500; }
p { margin: 0 0 10px; overflow-wrap: anywhere; }
.en { color: var(--muted); font-size: 14px; }
.hint { padding: 10px 12px; border-radius: 10px; background: var(--callout); }
.ip { margin: 16px 0 0; color: var(--muted); font: 13px ui-monospace, Menlo, Consolas, monospace; }
</style>
</head>
<body>
<main>
<h1>🔒 ${escapeHtml(translate("zh", vpnPromptKey))}<small>${escapeHtml(translate("en", vpnPromptKey))}</small></h1>
<p>${escapeHtml(translate("zh", deniedKey))}</p>
<p class="en">${escapeHtml(translate("en", deniedKey))}</p>
${hint ? `<p class="hint">${escapeHtml(hint)}</p>\n` : ""}<p class="ip">IP: ${escapeHtml(address ?? "?")}</p>
</main>
</body>
</html>
`;
}

const identityOf = (req) => {
  const email = String(req.get("x-relay-email") || req.query?.email || "")
    .toLowerCase().replace(/[^a-z0-9@._+-]/g, "").slice(0, 120);
  if (!email) return "-";
  const provider = String(req.get("x-relay-provider") || req.query?.provider || "")
    .toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);
  return provider ? `${email}#${provider}` : email;
};

export function createNetworkPolicy(config = {}) {
  const env = config.env ?? process.env;
  const pick = (name, key) => (config[name] !== undefined ? config[name] : env[key]);

  const mode = String(pick("mode", "GROUP_RELAY_NETWORK_MODE") ?? "off").trim().toLowerCase() || "off";
  if (!modes.has(mode)) {
    throw new Error(`Invalid GROUP_RELAY_NETWORK_MODE "${mode}" (expected off, report or enforce)`);
  }
  const cidrs = parseCidrList(pick("allowedCidrs", "GROUP_RELAY_ALLOWED_CIDRS"));
  const countries = parseCountries(pick("allowedCountries", "GROUP_RELAY_ALLOWED_COUNTRIES"));
  const hasRules = cidrs.count > 0 || countries.size > 0;
  if (mode === "enforce" && !hasRules) {
    throw new Error(
      "GROUP_RELAY_NETWORK_MODE=enforce needs GROUP_RELAY_ALLOWED_CIDRS or GROUP_RELAY_ALLOWED_COUNTRIES; "
      + "with neither, every visitor would be turned away"
    );
  }
  const hint = String(pick("hint", "GROUP_RELAY_NETWORK_HINT") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  /// 被拦的长轮询不立刻回 403:现有客户端(尤其装在各人电脑上、没法立刻升级的桌面端)
  /// 失败后几秒就重试,立刻拒绝只会把一个 25 秒一次的轮询变成一秒几次的重试风暴。
  /// 拖满一个长轮询的时长再回,被拦客户端的请求频率就和正常空闲时一样。
  const rawHold = Number(pick("denyHoldMs", "GROUP_RELAY_NETWORK_DENY_HOLD_MS") ?? 25_000);
  const denyHoldMs = Number.isFinite(rawHold) ? Math.min(Math.max(rawHold, 0), 30_000) : 25_000;
  const clock = config.clock ?? Date.now;
  const log = config.log ?? ((line) => console.log(line));
  const rate = parseRateLimit(pick("rateLimit", "GROUP_RELAY_RATE_LIMIT"));
  const limiter = rate ? createRateLimiter(rate, clock) : null;

  const held = new Set();
  const seen = new Set();
  let logBudget = 0;
  let budgetResetAt = 0;

  /// 回环对端 + CF-Connecting-IP = 隧道转来的外部请求;回环对端 + 无任何代理痕迹 = 本机;
  /// 回环对端 + 有代理痕迹却没有 CF-Connecting-IP = 认不出来源(见文件头)。
  function describeConnection(req) {
    const peerAddress = req.socket?.remoteAddress;
    if (!isLoopback(peerAddress)) {
      return { via: "direct", address: normalizeAddress(peerAddress), country: null };
    }
    const forwarded = normalizeAddress(req.get("cf-connecting-ip"));
    if (forwarded) {
      const country = String(req.get("cf-ipcountry") ?? "").trim().toUpperCase();
      return {
        via: "cloudflare",
        address: forwarded,
        country: /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null
      };
    }
    const proxied = Object.keys(req.headers).some(
      (name) => name.startsWith("cf-") || name === "x-forwarded-for" || name === "x-real-ip"
    );
    return proxied
      ? { via: "unverified", address: null, country: null }
      : { via: "local", address: normalizeAddress(peerAddress), country: null };
  }

  function evaluate(connection) {
    if (connection.via === "local") return { allowed: true, reason: "local" };
    if (!hasRules) return { allowed: true, reason: "no-rules" };
    if (connection.via === "unverified") return { allowed: false, reason: "unverified-proxy" };
    const family = connection.address && net.isIPv6(connection.address) ? "ipv6" : "ipv4";
    if (cidrs.count && connection.address && cidrs.list.check(connection.address, family)) {
      return { allowed: true, reason: "cidr" };
    }
    if (connection.country && countries.has(connection.country)) return { allowed: true, reason: "country" };
    return { allowed: false, reason: "not-listed" };
  }

  /// 每个(地址, 身份)组合只记第一次。观察模式靠这些日志回答「谁从哪个国家、哪个地址连进来」,
  /// 再据此决定白名单怎么写;每分钟最多 60 行,被人刷地址也不会把日志灌满。
  function noteFirstSeen(req, connection, verdict) {
    const identity = identityOf(req);
    const key = `${connection.address ?? connection.via}|${identity}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 5_000) seen.delete(seen.values().next().value);
    const now = clock();
    if (now >= budgetResetAt) {
      logBudget = 60;
      budgetResetAt = now + 60_000;
    }
    if (logBudget <= 0) return;
    logBudget -= 1;
    const outcome = verdict.allowed ? "allow" : mode === "enforce" ? "deny" : "would-deny";
    log(
      `[network] first-seen ip=${connection.address ?? "-"} country=${connection.country ?? "-"} `
      + `via=${connection.via} identity=${identity} verdict=${outcome} reason=${verdict.reason}`
    );
  }

  const localized = (req, key) => translate(localeFromAcceptLanguage(req.get("accept-language")) ?? "zh", key);

  function deny(req, res, connection) {
    /// error 是一整句话:老客户端(编译好的桌面端)只认这个字段,原样显示成失败原因,
    /// 所以「先连 VPN」必须写在里面。title / message / hint 是给网页弹窗分开排版用的。
    const title = localized(req, vpnPromptKey);
    const message = localized(req, deniedKey);
    const error = `${title} — ${message}${hint ? ` ${hint}` : ""}`;
    const send = () => {
      if (res.headersSent || res.writableEnded) return;
      res.status(403).set("Cache-Control", "no-store");
      const wantsPage = req.method === "GET" && !req.path.startsWith("/api/")
        && (req.get("accept") ?? "").includes("text/html");
      if (wantsPage) {
        res.type("html").send(noticePage({ address: connection.address, hint }));
      } else {
        res.json({ error, title, message, hint: hint || null, code: "network_denied", ip: connection.address });
      }
    };
    const isLongPoll = req.method === "GET" && /\/messages\/wait$/.test(req.path);
    if (!isLongPoll || denyHoldMs <= 0) return send();
    const release = () => {
      clearTimeout(timer);
      held.delete(release);
      send();
    };
    const timer = setTimeout(release, denyHoldMs);
    held.add(release);
    res.once("close", () => {
      clearTimeout(timer);
      held.delete(release);
    });
  }

  function middleware(req, res, next) {
    const connection = describeConnection(req);
    const isHealth = req.method === "GET" && req.path === "/health";
    if (limiter && connection.via !== "local" && !isHealth) {
      const limited = limiter.hit(connection.address ?? connection.via);
      if (limited) {
        if (limited.first) log(`[network] rate-limited ip=${connection.address ?? "-"} via=${connection.via}`);
        res.status(429).set({ "Retry-After": String(limited.retryAfter), "Cache-Control": "no-store" })
          .json({ error: localized(req, rateLimitedKey), code: "rate_limited" });
        return;
      }
    }
    if (mode === "off") return next();
    const verdict = evaluate(connection);
    if (connection.via !== "local") noteFirstSeen(req, connection, verdict);
    if (verdict.allowed || mode === "report" || isHealth) return next();
    deny(req, res, connection);
  }

  /// 关机时把被拖着的拒绝立刻放掉,和长轮询的 drain 一个道理:关机期间不让任何请求挂着。
  function release() {
    const count = held.size;
    for (const finish of [...held]) finish();
    return count;
  }

  return { middleware, release, mode, evaluate, describeConnection };
}
