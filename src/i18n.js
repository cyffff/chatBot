/// 服务端也在发用户直接看得到的中文,只翻前端解决不了:
///   1. API 错误信息 —— 前端原样 toast 出来;
///   2. 服务端自己写进群聊的系统消息 —— 它们会永久留在聊天记录里。
/// 所以这两类字符串同样要过翻译层。key 和前端一个路子:中文原文当 key,查不到就回落中文,
/// 漏翻最坏只是那一条还是中文。占位符 {0} {1}。
const dictionaries = {
  en: {
    "目标服务器无法访问：{0}": "Target server unreachable: {0}",
    "目标服务器 /health 返回 {0}": "Target server /health returned {0}",
    "目标服务器返回 {0}": "Target server returned {0}",
    "目标服务器还在旧协议（没有 email 身份），先把它更新到这个版本再同步；否则同步过去的数据它认不出来，客户端切过去会全部失效。":
      "The target server still speaks the old protocol (no email identity). Update it to this version before syncing, "
      + "otherwise it cannot read what you send and clients that switch over will break.",
    "反馈只接受 AI 提交：把你的想法讲给自己的 AI，让它润色成工单后替你提交":
      "Feedback is accepted from AIs only: tell your own AI what you want and let it file the ticket for you",
    "工单状态由人来定：AI 只负责提": "Ticket status is set by people; AIs only file them",
    "【已批准执行】{0}": "[Approved] {0}",
    "任务因客户端重启或连接中断而停止，请重新发送任务。":
      "The task stopped because the client restarted or lost its connection. Please send it again.",
    "邀请链接已失效。": "This invite link is no longer valid.",
    "它的主人": "its owner",
    "没有接到这条任务（已过 {0} 分钟）。多半是执行端没在运行：客户端已退出、机器休眠，或本机 CLI 的登录/额度失效。请重发一次，或让 {1} 检查那台机器。":
      "Nobody picked this up ({0} min ago). The runner is most likely not running: the client quit, the machine is "
      + "asleep, or the local CLI's login/quota has run out. Send it again, or ask {1} to check that machine.",
    "{0}\n\n⚠️ 已过 {1} 分钟仍未回写结果，执行端可能已经退出。请重发一次这条提问。":
      "{0}\n\n⚠️ Still no result after {1} min — the runner has probably exited. Please send this question again.",
    "{0}\n\n（仍在进行，已 {1} 分钟）": "{0}\n\n(still working, {1} min so far)",
    "{0} 已加入群聊，正在监听消息。": "{0} joined the group and is listening.",
    "已接单，正在项目中免审批执行…": "Picked this up — running in the project without approval…",
    "正在处理这个问题，请稍等…": "Working on it…",
    "处理失败：{0}": "Failed: {0}",
    "需要使用本机工具，已发送给 {0} 审批。（该 AI 未开启免审批：开启后群内成员的指令会直接执行。）":
      "This needs local tools, so it went to {0} for approval. (Trusted execution is off for this AI: with it on, "
      + "instructions from group members run directly.)",
    "本机 {0} CLI 的登录已失效，请到运行 worker 的那台机器上重新登录（例如直接跑一次 {0} 并完成 /login），然后重试。":
      "The local {0} CLI login has expired. Sign in again on the machine running the worker (for example run {0} "
      + "and complete /login), then retry.",
    "AI 已静默 {0} 分钟（无输出、进程零 CPU），判定卡死并停止":
      "The AI went quiet for {0} min (no output, zero CPU) — treated as stuck and stopped",
    "AI 单次任务超过 {0} 分钟上限，已自动停止": "The task passed the {0} min cap and was stopped"
  }
};

export const supportedLocales = ["zh", "en"];

export function normalizeLocale(value) {
  const tag = String(value ?? "").trim().toLowerCase();
  if (!tag) return null;
  if (tag.startsWith("zh")) return "zh";
  if (tag.startsWith("en")) return "en";
  return null;
}

/// Accept-Language 兜底:拿不到账号偏好时(还没绑邮箱、AI 桥接发起的请求)按浏览器/客户端
/// 声明的语言走。q 值按大小排序,第一个认得出来的赢。
export function localeFromAcceptLanguage(header) {
  const entries = String(header ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const quality = params
        .map((param) => param.trim())
        .filter((param) => param.startsWith("q="))
        .map((param) => Number(param.slice(2)))[0];
      return { tag, quality: Number.isFinite(quality) ? quality : 1 };
    })
    .filter((entry) => entry.tag)
    .sort((left, right) => right.quality - left.quality);
  for (const entry of entries) {
    const locale = normalizeLocale(entry.tag);
    if (locale) return locale;
  }
  return null;
}

export function translate(locale, key, values = []) {
  const table = dictionaries[locale];
  const template = table?.[key] ?? key;
  return String(template).replace(/\{(\d+)\}/g, (match, index) => {
    const value = values[Number(index)];
    return value === undefined || value === null ? "" : String(value);
  });
}
