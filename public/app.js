import { markdownTableDefinition, splitMarkdownTableRow } from "./markdown.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  groupId: null,
  token: null,
  inviteToken: null,
  cursor: null,
  rendered: new Set(),
  realtimeStarted: false,
  presenceRefreshStarted: false,
  eventSource: null,
  presenceRefreshTimer: null,
  accountBootstrapPromise: null,
  memberId: null,
  members: [],
  canManageTrustedExecution: false,
  account: null,
  accountToken: null,
  accountSessions: [],
  aiProviderStatus: [],
  tasks: [],
  taskSummary: {},
  taskFilter: "all",
  taskRefreshTimer: null,
  profileAvatarDataUrl: null,
  overviewView: "overview"
};

const accountStorageKey = "relay-account-v1";
const aiProviderLabels = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
const nativeRequests = new Map();
let nativeRequestSequence = 0;
const views = ["#create-view", "#join-view", "#invalid-view", "#account-view", "#transfer-view", "#chat-view"];
function show(selector) {
  views.forEach((view) => $(view).classList.toggle("hidden", view !== selector));
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  setTimeout(() => element.classList.remove("visible"), 1800);
}

function desktopNativeBridge() {
  return window.webkit?.messageHandlers?.relayNative ?? window.chrome?.webview ?? null;
}

function handleNativeResponse(payload) {
  if (payload?.type !== "relayNativeResponse" || !payload.requestId) return;
  const pending = nativeRequests.get(payload.requestId);
  if (!pending) return;
  nativeRequests.delete(payload.requestId);
  clearTimeout(pending.timer);
  if (payload.ok) pending.resolve(payload.result ?? {});
  else pending.reject(new Error(payload.error || "桌面客户端操作失败"));
}

window.addEventListener("relay-native-response", (event) => handleNativeResponse(event.detail));
window.chrome?.webview?.addEventListener?.("message", (event) => handleNativeResponse(event.data));

function requestNative(action, payload = {}) {
  const bridge = desktopNativeBridge();
  if (!bridge) return Promise.reject(new Error("请在 Group Relay 桌面客户端中配置 AI"));
  const requestId = `native-${Date.now()}-${nativeRequestSequence += 1}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeRequests.delete(requestId);
      reject(new Error("桌面客户端响应超时"));
    }, 10_000);
    nativeRequests.set(requestId, { resolve, reject, timer });
    bridge.postMessage({ action, requestId, ...payload });
  });
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers);
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (!(options.body instanceof FormData) && options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

async function accountApi(url, options = {}) {
  const headers = new Headers(options.headers);
  if (state.accountToken) headers.set("X-Account-Token", state.accountToken);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function loadAccountCredential() {
  try {
    const credential = JSON.parse(localStorage.getItem(accountStorageKey) || "null");
    if (!credential?.accountToken) return false;
    if (desktopNativeBridge() && String(credential.email ?? "").endsWith("@device.group-relay.example.com")) {
      return false;
    }
    state.accountToken = credential.accountToken;
    return true;
  } catch {
    localStorage.removeItem(accountStorageKey);
    return false;
  }
}

function saveAccountCredential(account, accountToken) {
  state.account = account;
  state.accountToken = accountToken;
  localStorage.setItem(accountStorageKey, JSON.stringify({
    email: account.email,
    accountToken
  }));
  if (desktopNativeBridge() && !isAutomaticAccount(account)) {
    void requestNative("saveAccountCredential", { email: account.email, accountToken }).catch(() => {});
  }
}

function isAutomaticAccount(account = state.account) {
  return account?.email?.endsWith("@device.group-relay.example.com") === true;
}

async function createAutomaticAccount() {
  const deviceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { account, accountToken } = await accountApi("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email: `device-${deviceId}@device.group-relay.example.com` })
  });
  saveAccountCredential(account, accountToken);
  const cached = localBrowserSessionCredentials();
  if (cached.length) await importSessions(cached);
  return account;
}

async function restoreNativeAccountCredential() {
  if (!desktopNativeBridge()) return false;
  try {
    const credential = await requestNative("getAccountCredential");
    if (!credential?.accountToken) return false;
    state.accountToken = credential.accountToken;
    const { account } = await accountApi("/api/account");
    saveAccountCredential(account, credential.accountToken);
    return true;
  } catch {
    state.accountToken = null;
    return false;
  }
}

async function ensureAccountCredential() {
  if (loadAccountCredential()) return;
  if (!state.accountBootstrapPromise) {
    state.accountBootstrapPromise = restoreNativeAccountCredential()
      .then((restored) => restored || createAutomaticAccount())
      .finally(() => { state.accountBootstrapPromise = null; });
  }
  await state.accountBootstrapPromise;
}

async function ensureAccountForCurrentSession() {
  await ensureAccountCredential();
  await linkCurrentSessionToAccount();
}

function localBrowserSessionCredentials() {
  const sessions = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const match = key?.match(/^relay:([0-9a-f-]{36})$/i);
    if (!match) continue;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved?.token) sessions.push({ groupId: match[1], memberToken: saved.token });
    } catch {
      // Ignore malformed legacy cache entries.
    }
  }
  return sessions;
}

async function importSessions(sessions) {
  if (!sessions.length) return { imported: 0, rejected: [], sessions: [] };
  const result = await accountApi("/api/account/sessions/import", {
    method: "POST",
    body: JSON.stringify({ sessions })
  });
  for (const session of result.sessions) {
    localStorage.setItem(`relay:${session.group.id}`, JSON.stringify({ token: session.memberToken }));
  }
  return result;
}

async function linkCurrentSessionToAccount() {
  if (!loadAccountCredential() || !state.groupId || !state.token) return;
  await importSessions([{ groupId: state.groupId, memberToken: state.token }]);
}

function saveSession() {
  localStorage.setItem(`relay:${state.groupId}`, JSON.stringify({ token: state.token }));
  if (state.inviteToken) {
    localStorage.setItem(`relay-invite:${state.inviteToken}`, state.groupId);
  }
}

async function resumeSession(groupId, inviteToken = null) {
  const saved = JSON.parse(localStorage.getItem(`relay:${groupId}`) || "null");
  if (!saved?.token) return false;
  const previous = {
    groupId: state.groupId,
    token: state.token,
    inviteToken: state.inviteToken
  };
  state.groupId = groupId;
  state.token = saved.token;
  state.inviteToken = inviteToken;
  showChatLoading();
  try {
    await loadChat();
    history.replaceState({}, "", `/group/${state.groupId}`);
    saveSession();
    if (inviteToken) {
      localStorage.setItem(`relay-invite:${inviteToken}`, groupId);
    }
    return true;
  } catch {
    localStorage.removeItem(`relay:${groupId}`);
    if (inviteToken) localStorage.removeItem(`relay-invite:${inviteToken}`);
    state.groupId = previous.groupId;
    state.token = previous.token;
    state.inviteToken = previous.inviteToken;
    return false;
  }
}

async function findKnownSessions() {
  const sessions = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const match = key?.match(/^relay:([0-9a-f-]{36})$/i);
    if (!match) continue;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved?.token) continue;
      const response = await fetch(`/api/groups/${match[1]}`, {
        headers: { Authorization: `Bearer ${saved.token}` }
      });
      if (!response.ok) continue;
      const { group } = await response.json();
      sessions.push({ id: group.id, name: group.name });
    } catch {
      // Ignore stale sessions while looking for a recoverable membership.
    }
  }
  return sessions;
}

function showInvalidInvite(sessions = []) {
  const container = $("#known-groups");
  const links = $("#known-group-links");
  links.innerHTML = "";
  for (const session of sessions) {
    const link = document.createElement("a");
    link.className = "button-link";
    link.href = `/group/${session.id}`;
    link.textContent = `返回「${session.name}」`;
    links.append(link);
  }
  container.classList.toggle("hidden", sessions.length === 0);
  show("#invalid-view");
}

async function recoverLegacySession(inviteToken) {
  const sessions = await findKnownSessions();
  if (sessions.length === 1 && await resumeSession(sessions[0].id, inviteToken)) {
    return true;
  }
  showInvalidInvite(sessions);
  return false;
}

function memberLabel(member) {
  return member.type === "ai" ? member.provider : "真人";
}

function presenceLabel(member) {
  return {
    online: "在线",
    busy: "忙碌",
    offline: "离线"
  }[member.presence?.status] ?? "离线";
}

function displayName(member) {
  if (member.type === "ai" && member.ownerName) {
    return `${member.ownerName}’s ${member.name}`;
  }
  return member.name;
}

function insertMemberMention(member, { replaceActiveQuery = false } = {}) {
  const textarea = $("#message-form [name=text]");
  const cursorStart = textarea.selectionStart ?? textarea.value.length;
  const cursorEnd = textarea.selectionEnd ?? cursorStart;
  let replaceStart = cursorStart;
  let replaceEnd = cursorEnd;
  if (replaceActiveQuery) {
    const beforeCursor = textarea.value.slice(0, cursorStart);
    const activeQuery = beforeCursor.match(/(^|\s)@[^@\n]*$/);
    if (activeQuery) replaceStart = activeQuery.index + activeQuery[1].length;
  }
  const before = textarea.value.slice(0, replaceStart);
  const after = textarea.value.slice(replaceEnd);
  const leadingSpace = before && !/\s$/.test(before) ? " " : "";
  const trailingSpace = !after || !/^\s/.test(after) ? " " : "";
  const insertion = `${leadingSpace}@${displayName(member)}${trailingSpace}`;
  textarea.value = `${before}${insertion}${after}`;
  const nextCursor = before.length + insertion.length;
  textarea.focus();
  textarea.setSelectionRange(nextCursor, nextCursor);
  $("#mention-menu").classList.add("hidden");
}

function renderMembers(members) {
  state.members = members;
  $("#member-list").innerHTML = "";
  for (const member of members) {
    const item = document.createElement("li");
    const avatar = document.createElement("span");
    avatar.className = `avatar ${member.type === "ai" ? "ai" : ""}`;
    avatar.textContent = member.type === "ai" ? "AI" : member.name.slice(0, 1).toUpperCase();
    const text = document.createElement("span");
    text.textContent = displayName(member);
    const meta = document.createElement("small");
    meta.className = "member-meta";
    if (member.type === "ai") {
      const dot = document.createElement("span");
      dot.className = `presence-dot ${member.presence?.status ?? "offline"}`;
      meta.append(dot, document.createTextNode(`${memberLabel(member)} · ${presenceLabel(member)}`));
    } else {
      meta.textContent = memberLabel(member);
    }
    text.append(meta);
    const mention = document.createElement("button");
    mention.type = "button";
    mention.className = "member-mention";
    mention.title = `点击 @${displayName(member)}`;
    mention.setAttribute("aria-label", `@${displayName(member)}`);
    mention.append(avatar, text);
    mention.addEventListener("click", () => insertMemberMention(member));
    item.append(mention);
    if (member.type === "ai" && member.canManageTrustedExecution) {
      const trust = document.createElement("button");
      trust.type = "button";
      trust.className = `member-trust ${member.trustedExecutionEnabled ? "enabled" : ""}`;
      trust.textContent = member.trustedExecutionEnabled ? "免审批：开" : "免审批：关";
      trust.title = member.trustedExecutionEnabled
        ? "只有你的消息可以让该 AI 在项目中免审批执行；点击关闭"
        : "允许该 AI 对你的消息在绑定项目中免审批执行";
      trust.addEventListener("click", async () => {
        trust.disabled = true;
        try {
          const result = await api(
            `/api/groups/${state.groupId}/members/${member.id}/trusted-execution`,
            { method: "POST", body: JSON.stringify({ enabled: !member.trustedExecutionEnabled }) }
          );
          const index = state.members.findIndex((candidate) => candidate.id === member.id);
          if (index >= 0) state.members[index] = result.member;
          renderMembers(state.members);
          toast(result.member.trustedExecutionEnabled ? "已开启我的 AI 免审批执行" : "已关闭免审批执行");
        } catch (error) {
          trust.disabled = false;
          toast(error.message);
        }
      });
      item.append(trust);
    }
    $("#member-list").append(item);
  }
}

function applyMemberEvent(eventName, payload) {
  if (eventName === "member_presence") {
    const member = state.members.find((candidate) => candidate.id === payload.id);
    if (!member) return refreshMembers();
    member.presence = payload.presence;
    renderMembers(state.members);
    return Promise.resolve();
  }
  if (eventName === "member_left") {
    renderMembers(state.members.filter((member) => member.id !== payload.id));
    return Promise.resolve();
  }
  if (eventName === "member_joined" || eventName === "member_updated") return refreshMembers();
  return Promise.resolve();
}

function messagesAreNearBottom() {
  const messages = $("#messages");
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
}

function scrollMessagesToBottom() {
  const messages = $("#messages");
  messages.scrollTop = messages.scrollHeight;
}

function appendInlineMarkdown(parent, source) {
  const tokenPattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    parent.append(document.createTextNode(source.slice(cursor, match.index)));
    if (match[2] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      parent.append(strong);
    } else if (match[3] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[3];
      parent.append(code);
    } else {
      const link = document.createElement("a");
      link.textContent = match[4];
      link.href = match[5];
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      parent.append(link);
    }
    cursor = match.index + match[0].length;
  }
  parent.append(document.createTextNode(source.slice(cursor)));
}

function markdownBlockStart(line) {
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,4}\s+/.test(line)
    || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^\s*>\s?/.test(line);
}

function renderMarkdown(target, source) {
  target.replaceChildren();
  target.classList.add("markdown-body");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (language) code.dataset.language = language;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      target.append(pre);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      appendInlineMarkdown(element, heading[2]);
      target.append(element);
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      target.append(document.createElement("hr"));
      index += 1;
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const pattern = unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      while (index < lines.length) {
        const entry = lines[index].match(pattern);
        if (!entry) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, entry[1]);
        list.append(item);
        index += 1;
      }
      target.append(list);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      quoteLines.forEach((quoteLine, quoteIndex) => {
        if (quoteIndex) quote.append(document.createElement("br"));
        appendInlineMarkdown(quote, quoteLine);
      });
      target.append(quote);
      continue;
    }
    const tableDefinition = markdownTableDefinition(lines, index);
    if (tableDefinition) {
      const scroll = document.createElement("div");
      scroll.className = "markdown-table-scroll";
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headingRow = document.createElement("tr");
      tableDefinition.headers.forEach((content, cellIndex) => {
        const cell = document.createElement("th");
        cell.style.textAlign = tableDefinition.alignments[cellIndex];
        appendInlineMarkdown(cell, content);
        headingRow.append(cell);
      });
      head.append(headingRow);
      table.append(head);
      const body = document.createElement("tbody");
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const values = splitMarkdownTableRow(lines[index]);
        const row = document.createElement("tr");
        tableDefinition.headers.forEach((_, cellIndex) => {
          const cell = document.createElement("td");
          cell.style.textAlign = tableDefinition.alignments[cellIndex];
          appendInlineMarkdown(cell, values[cellIndex] ?? "");
          row.append(cell);
        });
        body.append(row);
        index += 1;
      }
      table.append(body);
      scroll.append(table);
      target.append(scroll);
      continue;
    }
    const paragraph = document.createElement("p");
    let firstLine = true;
    while (index < lines.length
      && lines[index].trim()
      && !markdownBlockStart(lines[index])
      && !markdownTableDefinition(lines, index)) {
      if (!firstLine) paragraph.append(document.createElement("br"));
      appendInlineMarkdown(paragraph, lines[index]);
      firstLine = false;
      index += 1;
    }
    target.append(paragraph);
  }
}

function updateMessageNode(item, message) {
  let bubble = item.querySelector(".bubble");
  if (message.text) {
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "bubble";
      item.append(bubble);
    }
    renderMarkdown(bubble, message.text);
  } else {
    bubble?.remove();
  }
  item.classList.toggle("processing", message.status === "processing");
  item.classList.toggle("failed", message.status === "failed");
  let status = item.querySelector(".message-status");
  if (message.status === "processing") {
    if (!status) {
      status = document.createElement("span");
      status.className = "message-status";
      item.querySelector(".message-head")?.append(status);
    }
    status.textContent = "正在处理";
  } else if (message.status === "failed") {
    if (!status) {
      status = document.createElement("span");
      status.className = "message-status";
      item.querySelector(".message-head")?.append(status);
    }
    status.textContent = "处理失败";
  } else {
    status?.remove();
  }
}

function updateRenderedMessage(message) {
  const item = [...$("#messages").children]
    .find((candidate) => candidate.dataset.messageId === message.id);
  if (!item) {
    renderMessage(message);
    return;
  }
  const shouldFollow = messagesAreNearBottom();
  updateMessageNode(item, message);
  if (shouldFollow) requestAnimationFrame(scrollMessagesToBottom);
}

function attachmentNode(attachment) {
  const link = document.createElement("a");
  link.className = "attachment";
  link.href = `${attachment.url}?token=${encodeURIComponent(state.token)}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  if (attachment.mimeType.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = link.href;
    image.alt = attachment.name;
    link.append(image);
  }
  link.append(document.createTextNode(`${attachment.name} · ${Math.ceil(attachment.size / 1024)} KB`));
  return link;
}

function renderMessage(message) {
  if (state.rendered.has(message.id)) return;
  const shouldFollow = messagesAreNearBottom();
  state.rendered.add(message.id);
  state.cursor = message.id;
  const item = document.createElement("li");
  item.className = "message";
  item.dataset.messageId = message.id;
  if (message.mentions?.some((mention) => mention.id === state.memberId)) {
    item.classList.add("mentions-me");
  }
  const head = document.createElement("div");
  head.className = "message-head";
  const sender = document.createElement("span");
  sender.className = "sender";
  sender.textContent = displayName(message.sender);
  head.append(sender);
  if (message.sender.provider) {
    const provider = document.createElement("span");
    provider.className = "provider";
    provider.textContent = message.sender.provider;
    head.append(provider);
  }
  const time = document.createElement("time");
  time.className = "time";
  time.textContent = new Date(message.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  head.append(time);
  item.append(head);
  updateMessageNode(item, message);
  if (message.attachments?.length) {
    const attachments = document.createElement("div");
    attachments.className = "attachments";
    message.attachments.forEach((file) => attachments.append(attachmentNode(file)));
    item.append(attachments);
  }
  $("#messages").append(item);
  if (shouldFollow) requestAnimationFrame(scrollMessagesToBottom);
  for (const image of item.querySelectorAll("img")) {
    image.addEventListener("load", () => {
      if (shouldFollow) scrollMessagesToBottom();
    }, { once: true });
  }
}

async function loadChat() {
  const requestedGroupId = state.groupId;
  const [{ group, members, currentMemberId, canManageTrustedExecution }, { messages, cursor }] = await Promise.all([
    api(`/api/groups/${state.groupId}`),
    api(`/api/groups/${state.groupId}/messages?limit=200`)
  ]);
  if (state.groupId !== requestedGroupId) return false;
  state.inviteToken = group.inviteToken;
  state.memberId = currentMemberId;
  state.canManageTrustedExecution = canManageTrustedExecution === true;
  $("#group-name").textContent = group.name;
  $("#messages").innerHTML = "";
  renderMembers(members);
  messages.forEach(renderMessage);
  state.cursor = cursor;
  show("#chat-view");
  requestAnimationFrame(() => {
    scrollMessagesToBottom();
    requestAnimationFrame(scrollMessagesToBottom);
  });
  startRealtime();
  startPresenceRefresh();
  void refreshChatAIControls();
  return true;
}

async function refreshMembers() {
  const { members } = await api(`/api/groups/${state.groupId}`);
  renderMembers(members);
}

function startPresenceRefresh() {
  if (state.presenceRefreshStarted) return;
  state.presenceRefreshStarted = true;
  state.presenceRefreshTimer = setInterval(() => refreshMembers().catch(() => {}), 30_000);
}

function markConnected() {
  $("#connection").textContent = "实时连接";
  $("#connection").classList.add("online");
}

function startRealtime() {
  if (state.realtimeStarted) return;
  state.realtimeStarted = true;
  connectEvents();
  pollMessages();
}

function connectEvents() {
  state.eventSource?.close();
  const events = new EventSource(`/api/groups/${state.groupId}/events?token=${encodeURIComponent(state.token)}`);
  state.eventSource = events;
  events.addEventListener("ready", markConnected);
  events.addEventListener("message", (event) => renderMessage(JSON.parse(event.data)));
  events.addEventListener("message_updated", (event) => updateRenderedMessage(JSON.parse(event.data)));
  for (const eventName of ["member_joined", "member_left", "member_presence", "member_updated"]) {
    events.addEventListener(eventName, (event) => {
      applyMemberEvent(eventName, JSON.parse(event.data)).catch(() => {});
    });
  }
  events.onerror = () => {
    $("#connection").textContent = "备用连接";
  };
}

async function pollMessages() {
  while (state.groupId && state.token) {
    try {
      const requestedGroupId = state.groupId;
      const query = new URLSearchParams({ timeoutMs: "25000", limit: "200" });
      if (state.cursor) query.set("after", state.cursor);
      const { messages, event, eventPayload } = await api(`/api/groups/${state.groupId}/messages/wait?${query}`);
      if (state.groupId !== requestedGroupId) break;
      messages.forEach(renderMessage);
      if (event === "message_updated" && eventPayload) {
        updateRenderedMessage(eventPayload);
      } else if (event && event !== "message" && eventPayload) {
        await applyMemberEvent(event, eventPayload);
      }
      markConnected();
    } catch {
      $("#connection").textContent = "正在重连";
      $("#connection").classList.remove("online");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

function stopChatRealtime() {
  state.eventSource?.close();
  state.eventSource = null;
  if (state.presenceRefreshTimer) clearInterval(state.presenceRefreshTimer);
  state.presenceRefreshTimer = null;
  state.presenceRefreshStarted = false;
  state.realtimeStarted = false;
  state.groupId = null;
  state.token = null;
  state.inviteToken = null;
  state.cursor = null;
  state.memberId = null;
  state.members = [];
  state.rendered.clear();
  $("#chat-ai-panel").classList.add("hidden");
}

function showChatLoading(groupName = "") {
  $("#group-name").textContent = groupName || "正在打开群组";
  $("#connection").textContent = "正在加载消息…";
  $("#connection").classList.remove("online");
  $("#member-list").innerHTML = "";
  $("#chat-ai-panel").classList.add("hidden");
  $("#messages").innerHTML = "";
  $("#mention-menu").classList.add("hidden");
  $("#file-count").textContent = "";
  const loading = document.createElement("li");
  loading.className = "chat-loading";
  const spinner = document.createElement("span");
  spinner.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "正在进入群组";
  const detail = document.createElement("small");
  detail.textContent = "正在同步成员和最近消息…";
  copy.append(title, detail);
  loading.append(spinner, copy);
  $("#messages").append(loading);
  show("#chat-view");
}

async function openAccountSession(session) {
  stopChatRealtime();
  state.groupId = session.group.id;
  state.token = session.memberToken;
  localStorage.setItem(`relay:${state.groupId}`, JSON.stringify({ token: state.token }));
  history.replaceState({}, "", `/group/${state.groupId}`);
  showChatLoading(session.group.name);
  try {
    await loadChat();
  } catch (error) {
    stopChatRealtime();
    history.replaceState({}, "", "/app#groups");
    showAccountDashboardShell("groups");
    toast(`无法打开群组：${error.message}`);
  }
}

function renderAccountSessions(sessions) {
  const list = $("#session-list");
  list.innerHTML = "";
  $("#account-loading").classList.add("hidden");
  $("#account-loading").classList.remove("error");
  $("#overview-group-count").textContent = sessions.length;
  $("#empty-sessions").classList.toggle("hidden", sessions.length !== 0);
  for (const session of sessions) {
    const item = document.createElement("article");
    item.className = "session-card";
    const details = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = session.group.name;
    const meta = document.createElement("p");
    meta.textContent = `${displayName(session.member)} · 加入于 ${new Date(session.linkedAt).toLocaleDateString()}`;
    const aiControls = document.createElement("div");
    aiControls.className = "desktop-ai-controls";
    const aiLabel = document.createElement("span");
    aiLabel.textContent = "我的桌面 AI";
    aiControls.append(aiLabel);
    const attachedProviders = new Set((session.desktopAis ?? []).map((member) => member.provider));
    for (const provider of ["codex", "claude", "cursor"]) {
      const labels = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
      const attached = attachedProviders.has(provider);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `desktop-ai-toggle ${attached ? "attached" : ""}`;
      toggle.textContent = attached ? `${labels[provider]} · 离开` : `＋ ${labels[provider]}`;
      toggle.title = attached
        ? `让我的 ${labels[provider]} 离开这个群组`
        : `把本机已登录的 ${labels[provider]} 加入这个群组`;
      toggle.addEventListener("click", async () => {
        const nativeBridge = window.webkit?.messageHandlers?.relayNative ?? window.chrome?.webview;
        toggle.disabled = true;
        try {
          if (attached) {
            const result = await accountApi(
              `/api/account/sessions/${session.group.id}/ais/${provider}`,
              { method: "DELETE" }
            );
            nativeBridge?.postMessage({ action: "removeAIWorker", workerId: result.workerId });
            toast(`${labels[provider]} 已离开 ${session.group.name}`);
          } else {
            const result = await accountApi(`/api/account/sessions/${session.group.id}/ais`, {
              method: "POST",
              body: JSON.stringify({ provider })
            });
            nativeBridge?.postMessage({ action: "configureAIWorker", worker: result.worker });
            toast(nativeBridge
              ? `${labels[provider]} 已加入 ${session.group.name}`
              : `${labels[provider]} 已加入，等待桌面客户端自动连接`);
          }
          await loadAccountDashboard();
        } catch (error) {
          toggle.disabled = false;
          toast(error.message);
        }
      });
      aiControls.append(toggle);
    }
    details.append(title, meta, aiControls);
    const actions = document.createElement("div");
    actions.className = "session-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "打开";
    open.addEventListener("click", () => { void openAccountSession(session); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "移出列表";
    remove.addEventListener("click", async () => {
      try {
        await accountApi(`/api/account/sessions/${session.group.id}`, { method: "DELETE" });
        await loadAccountDashboard();
      } catch (error) {
        toast(error.message);
      }
    });
    actions.append(open, remove);
    item.append(details, actions);
    list.append(item);
  }
}

const taskStatusLabels = {
  assigned: "待开始",
  in_progress: "进行中",
  completed: "已完成",
  failed: "需处理"
};

function accountEmailNickname(account) {
  if (isAutomaticAccount(account)) return "我";
  const prefix = String(account?.email ?? "").split("@")[0].trim();
  return prefix && !prefix.toLocaleLowerCase().startsWith("device-") ? prefix : "我";
}

function accountOwnerName(account) {
  const saved = String(account?.displayName ?? "").trim();
  if (saved && !saved.toLocaleLowerCase().startsWith("device-")) return saved;
  return accountEmailNickname(account);
}

function renderAvatar(imageSelector, fallbackSelector, avatarDataUrl, owner) {
  const image = $(imageSelector);
  const fallback = $(fallbackSelector);
  if (avatarDataUrl) {
    image.src = avatarDataUrl;
    image.classList.remove("hidden");
    fallback.classList.add("hidden");
  } else {
    image.removeAttribute("src");
    image.classList.add("hidden");
    fallback.textContent = Array.from(owner || "我")[0]?.toLocaleUpperCase() ?? "我";
    fallback.classList.remove("hidden");
  }
}

function renderAccountProfile(account) {
  const owner = accountOwnerName(account);
  state.profileAvatarDataUrl = account.avatarDataUrl ?? null;
  const form = $("#profile-settings-form");
  form.elements.displayName.value = owner;
  form.dataset.savedName = owner;
  $("#profile-display-name").textContent = owner;
  $("#profile-email").textContent = account.email;
  renderAvatar("#sidebar-avatar-image", "#sidebar-avatar-fallback", account.avatarDataUrl, owner);
  renderAvatar("#profile-avatar-image", "#profile-avatar-fallback", account.avatarDataUrl, owner);
  setProfileEditing(false);
  return owner;
}

function setProfileEditing(editing) {
  $("#profile-editor").classList.toggle("hidden", !editing);
  $("#edit-profile").classList.toggle("hidden", editing);
  if (editing) $("#profile-settings-form [name=displayName]").focus();
}

function renderOverviewHeader(account) {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const owner = renderAccountProfile(account);
  $("#overview-greeting").textContent = greeting;
  $("#overview-owner").textContent = owner;
  $("#dashboard-owner").textContent = owner;
  $("#sidebar-owner").textContent = owner;
  $("#overview-date").textContent = now.toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric", weekday: "long"
  });
}

function renderOverviewCalendar() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  $("#calendar-title").textContent = `${year}年${month + 1}月`;
  $("#calendar-today").textContent = `${month + 1}/${now.getDate()}`;
  const grid = $("#calendar-grid");
  grid.innerHTML = "";
  for (let index = 0; index < firstDay; index += 1) {
    const blank = document.createElement("span");
    blank.className = "muted-day";
    grid.append(blank);
  }
  for (let day = 1; day <= days; day += 1) {
    const cell = document.createElement("span");
    cell.textContent = day;
    if (day === now.getDate()) cell.className = "today";
    grid.append(cell);
  }
}

function taskAssigneeName(assignee) {
  return assignee.ownerName ? `${assignee.ownerName}’s ${assignee.name}` : assignee.name;
}

function renderAITasks() {
  const summary = state.taskSummary;
  $("#overview-task-count").textContent = state.tasks.length;
  $("#overview-progress-count").textContent = summary.in_progress ?? 0;
  $("#overview-completed-count").textContent = summary.completed ?? 0;
  $("#task-count-all").textContent = state.tasks.length;
  $("#task-count-assigned").textContent = summary.assigned ?? 0;
  $("#task-count-in-progress").textContent = summary.in_progress ?? 0;
  $("#task-count-completed").textContent = summary.completed ?? 0;
  $("#task-count-failed").textContent = summary.failed ?? 0;
  const visible = state.taskFilter === "all"
    ? state.tasks
    : state.tasks.filter((task) => task.status === state.taskFilter);
  const list = $("#ai-task-list");
  list.innerHTML = "";
  $("#empty-ai-tasks").classList.toggle("hidden", visible.length !== 0);
  for (const task of visible) {
    const card = document.createElement("article");
    card.className = `ai-task-card ${task.status}`;
    const mark = document.createElement("span");
    mark.className = "task-status-mark";
    mark.title = taskStatusLabels[task.status] ?? task.status;
    const body = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "task-title";
    title.textContent = task.title;
    const meta = document.createElement("p");
    meta.className = "task-meta";
    meta.textContent = `${taskStatusLabels[task.status] ?? task.status} · ${taskAssigneeName(task.assignee)} · ${task.group.name} · ${new Date(task.updatedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
    body.append(title, meta);
    const reportText = task.report || (task.status === "in_progress" ? task.progress : null);
    if (reportText) {
      const report = document.createElement("p");
      report.className = "task-report";
      report.textContent = reportText;
      body.append(report);
    }
    const links = document.createElement("div");
    links.className = "task-links";
    const jira = document.createElement("a");
    jira.href = task.jira.url;
    jira.target = "_blank";
    jira.rel = "noreferrer";
    jira.textContent = task.jira.key;
    const group = document.createElement("a");
    group.href = `/group/${task.group.id}`;
    group.textContent = "打开群聊";
    links.append(jira, group);
    card.append(mark, body, links);
    list.append(card);
  }
}

async function loadAccountTasks() {
  const result = await accountApi("/api/account/tasks");
  state.tasks = result.tasks;
  state.taskSummary = result.summary;
  renderAITasks();
}

function startTaskRefresh() {
  if (state.taskRefreshTimer) return;
  state.taskRefreshTimer = setInterval(() => loadAccountTasks().catch(() => {}), 10_000);
}

function overviewViewFromHash() {
  const hash = location.hash.toLowerCase();
  if (["#tasks", "#ai-workboard"].includes(hash)) return "tasks";
  if (["#groups", "#my-groups"].includes(hash)) return "groups";
  if (hash === "#settings") return "settings";
  return "overview";
}

function setOverviewView(view, { updateHash = true } = {}) {
  const nextView = ["overview", "tasks", "groups", "settings"].includes(view) ? view : "overview";
  state.overviewView = nextView;
  const content = $(".overview-content");
  content.dataset.view = nextView;
  document.querySelectorAll("[data-overview-view]").forEach((link) => {
    link.classList.toggle("active", link.dataset.overviewView === nextView);
    link.setAttribute("aria-current", link.dataset.overviewView === nextView ? "page" : "false");
  });
  content.scrollTop = 0;
  if (updateHash) history.replaceState({}, "", `${location.pathname}${location.search}#${nextView}`);
  if (nextView === "settings") void loadAISettings();
}

function renderAISettings(providers) {
  state.aiProviderStatus = providers;
  for (const provider of ["codex", "claude", "cursor"]) {
    const card = document.querySelector(`[data-ai-provider="${provider}"]`);
    const status = providers.find((item) => item.provider === provider) ?? {};
    const workerCount = Number(status.workerCount || 0);
    const keyConfigured = status.keyConfigured === true;
    const cliAvailable = status.cliAvailable === true;
    card.querySelector("[data-key-state]").textContent = keyConfigured ? "已配置（内容已隐藏）" : "未配置";
    card.querySelector("[data-mode-state]").textContent = keyConfigured
      ? "API Key（优先）"
      : cliAvailable ? "本机 CLI 登录账号" : "尚不可用";
    const cliState = card.querySelector("[data-cli-state]");
    cliState.textContent = cliAvailable ? "已安装" : "未找到";
    cliState.title = status.cliPath || "";
    card.querySelector("[data-key-storage]").textContent = keyConfigured
      ? (status.credentialStore || "本机安全凭据")
      : "未保存";
    card.querySelector("[data-worker-count]").textContent = `${workerCount} 个`;
    card.querySelector(".toggle-ai-key").textContent = keyConfigured ? "更换 API Key" : "配置 API Key";
    const help = card.querySelector("[data-provider-help]");
    const badge = card.querySelector(".provider-state");
    badge.classList.remove("ready", "active", "missing");
    help.classList.remove("ready", "missing");
    if (keyConfigured) {
      badge.textContent = "Key 已配置";
      badge.classList.add("ready");
      help.textContent = "后台回复会优先使用这个 API Key；保存新 Key 会覆盖旧配置。";
      help.classList.add("ready");
    } else if (cliAvailable) {
      badge.textContent = "CLI 可用";
      badge.classList.add("active");
      help.textContent = "尚未配置 API Key；后台将使用本机 CLI 的登录账号。也可以在下方保存 Key。";
    } else {
      badge.textContent = "未就绪";
      badge.classList.add("missing");
      help.textContent = `没有配置 API Key，也没有找到 ${aiProviderLabels[provider]} CLI。请保存 Key，或先安装并登录 CLI。`;
      help.classList.add("missing");
    }
    card.querySelector(".remove-ai-key").disabled = !keyConfigured;
  }
}

async function loadAISettings() {
  const notice = $("#ai-settings-notice");
  const forms = document.querySelectorAll(".ai-key-form");
  const toggles = document.querySelectorAll(".toggle-ai-key");
  if (!desktopNativeBridge()) {
    notice.textContent = "API Key 只允许在 macOS 或 Windows 桌面客户端中配置。网页版不会接收或保存密钥。";
    notice.className = "settings-notice warning";
    forms.forEach((form) => { form.querySelectorAll("input, button").forEach((control) => { control.disabled = true; }); });
    toggles.forEach((toggle) => { toggle.disabled = true; });
    renderAISettings([]);
    return;
  }
  notice.textContent = "正在读取本机安全凭据和 AI 接入状态…";
  notice.className = "settings-notice";
  forms.forEach((form) => { form.querySelectorAll("input, button").forEach((control) => { control.disabled = false; }); });
  toggles.forEach((toggle) => { toggle.disabled = false; });
  try {
    const result = await requestNative("getAISettings");
    renderAISettings(result.providers ?? []);
    const configuredCount = (result.providers ?? []).filter((provider) => provider.keyConfigured).length;
    notice.textContent = configuredCount > 0
      ? `已读取本机配置：${configuredCount} 个 API Key 已安全保存。完整密钥不会显示，也不会上传服务器。`
      : "当前没有保存 API Key；可使用已登录的本机 CLI，或在下方完成配置。";
  } catch (error) {
    notice.textContent = error.message;
    notice.className = "settings-notice error";
  }
}

function renderChatAIControls(session, providers) {
  const panel = $("#chat-ai-panel");
  const actions = $("#chat-ai-actions");
  const attachedProviders = new Set((session.desktopAis ?? []).map((member) => member.provider));
  const native = Boolean(desktopNativeBridge());
  const usableProviders = providers.filter((provider) => provider.cliAvailable === true || provider.remoteAvailable === true);
  panel.classList.remove("hidden");
  actions.innerHTML = "";
  $("#chat-ai-help").textContent = usableProviders.length
    ? native
      ? "选择已经在本机接入的 AI 加入当前群组。群成员随后可以直接 @ 它。"
      : "可把你的 AI 加入这个群组；已登录的桌面客户端会自动启动后台连接。"
    : "当前没有可运行的本机 AI。请先在“接入设置”中配置并安装对应 CLI。";

  for (const provider of ["codex", "claude", "cursor"]) {
    const label = aiProviderLabels[provider];
    const status = providers.find((item) => item.provider === provider) ?? {};
    const attached = attachedProviders.has(provider);
    const usable = status.cliAvailable === true || status.remoteAvailable === true;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `secondary ${attached ? "attached" : ""}`;
    button.textContent = attached ? `${label} · 离开` : usable ? `＋ ${label} 加入` : `${label} · 未接入`;
    button.disabled = !attached && !usable;
    button.title = attached
      ? `让我的 ${label} 离开当前群组`
      : usable ? `把本机 ${label} 加入当前群组` : `请先安装并配置 ${label} CLI`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const bridge = desktopNativeBridge();
        if (attached) {
          const result = await accountApi(`/api/account/sessions/${state.groupId}/ais/${provider}`, { method: "DELETE" });
          bridge?.postMessage({ action: "removeAIWorker", workerId: result.workerId });
          toast(`${label} 已离开当前群组`);
        } else {
          const result = await accountApi(`/api/account/sessions/${state.groupId}/ais`, {
            method: "POST",
            body: JSON.stringify({ provider })
          });
          bridge?.postMessage({ action: "configureAIWorker", worker: result.worker });
          toast(bridge ? `${label} 已加入当前群组` : `${label} 已加入，等待桌面客户端自动连接`);
        }
        await Promise.all([refreshMembers(), refreshChatAIControls()]);
      } catch (error) {
        button.disabled = false;
        toast(error.message);
      }
    });
    actions.append(button);
  }
}

async function refreshChatAIControls() {
  const requestedGroupId = state.groupId;
  if (!requestedGroupId) {
    $("#chat-ai-panel").classList.add("hidden");
    return;
  }
  $("#chat-ai-panel").classList.remove("hidden");
  $("#chat-ai-help").textContent = "正在读取本机 AI 配置…";
  $("#chat-ai-actions").innerHTML = "";
  try {
    await ensureAccountForCurrentSession();
    const native = Boolean(desktopNativeBridge());
    const [{ sessions }, settings] = await Promise.all([
      accountApi("/api/account/sessions"),
      native
        ? requestNative("getAISettings")
        : Promise.resolve({ providers: Object.keys(aiProviderLabels).map((provider) => ({ provider, remoteAvailable: true })) })
    ]);
    if (state.groupId !== requestedGroupId) return;
    state.accountSessions = sessions;
    state.aiProviderStatus = settings.providers ?? [];
    const session = sessions.find((item) => item.group.id === requestedGroupId);
    if (!session) throw new Error("当前群组尚未同步到本机账户");
    renderChatAIControls(session, state.aiProviderStatus);
  } catch (error) {
    if (state.groupId !== requestedGroupId) return;
    $("#chat-ai-help").textContent = error.message;
  }
}

function showAccountDashboardShell(view = overviewViewFromHash()) {
  $("#account-dashboard").classList.remove("hidden");
  $("#account-view").classList.add("dashboard-mode");
  show("#account-view");
  setOverviewView(view, { updateHash: false });
  if (!$("#session-list").children.length) {
    $("#empty-sessions").classList.add("hidden");
    $("#account-loading").classList.remove("hidden", "error");
    $("#account-loading strong").textContent = "正在打开我的群组";
    $("#account-loading small").textContent = "同步本机身份和会话…";
  }
}

async function loadAccountDashboard() {
  const [{ account }, { sessions }, taskData] = await Promise.all([
    accountApi("/api/account"),
    accountApi("/api/account/sessions"),
    accountApi("/api/account/tasks")
  ]);
  state.account = account;
  state.accountSessions = sessions;
  state.tasks = taskData.tasks;
  state.taskSummary = taskData.summary;
  $("#account-email").textContent = isAutomaticAccount(account) ? "本机自动账户" : account.email;
  renderOverviewHeader(account);
  renderOverviewCalendar();
  for (const session of sessions) {
    localStorage.setItem(`relay:${session.group.id}`, JSON.stringify({ token: session.memberToken }));
  }
  renderAccountSessions(sessions);
  renderAITasks();
  startTaskRefresh();
  const ownerInput = $("#account-create-form [name=ownerName]");
  if (!ownerInput.value) ownerInput.value = accountOwnerName(account);
  $("#account-create-panel").classList.add("hidden");
  $("#account-dashboard").classList.remove("hidden");
  $("#account-view").classList.add("dashboard-mode");
  show("#account-view");
  setOverviewView(overviewViewFromHash(), { updateHash: false });
  return sessions;
}

async function showAccountView() {
  showAccountDashboardShell();
  try {
    await ensureAccountCredential();
    await loadAccountDashboard();
  } catch (error) {
    if (error.message === "invalid account token") {
      localStorage.removeItem(accountStorageKey);
      if (desktopNativeBridge()) void requestNative("deleteAccountCredential").catch(() => {});
      state.account = null;
      state.accountToken = null;
      await createAutomaticAccount();
      await loadAccountDashboard();
      toast("旧账户已失效，已自动恢复本机群组");
      return;
    }
    $("#account-loading").classList.remove("hidden");
    $("#account-loading").classList.add("error");
    $("#account-loading strong").textContent = "群组加载失败";
    $("#account-loading small").textContent = error.message;
    toast(error.message);
  }
}

async function restoreAccountBackup(backup) {
  const accountToken = backup.accountToken ?? backup.account?.accountToken;
  if (!accountToken || !Array.isArray(backup.sessions)) {
    throw new Error("不是有效的 Group Relay 账户备份");
  }
  const previousToken = state.accountToken;
  const previousAccount = state.account;
  state.accountToken = accountToken;
  let account;
  try {
    ({ account } = await accountApi("/api/account"));
  } catch (error) {
    state.accountToken = previousToken;
    state.account = previousAccount;
    throw error;
  }
  saveAccountCredential(account, accountToken);
  const sessions = backup.sessions.map((session) => ({
    groupId: session.groupId ?? session.group?.id,
    memberToken: session.memberToken
  })).filter((session) => session.groupId && session.memberToken);
  if (sessions.length) await importSessions(sessions);
  await loadAccountDashboard();
  toast("账户和会话已恢复");
}

async function handleBackupInput(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const hasAccount = Boolean(backup.accountToken ?? backup.account?.accountToken);
    if (hasAccount) {
      await restoreAccountBackup(backup);
      return;
    }
    if (!Array.isArray(backup.sessions)) {
      throw new Error("不是有效的 Group Relay 备份");
    }
    if (!state.accountToken && !loadAccountCredential()) await createAutomaticAccount();
    const sessions = backup.sessions.map((session) => ({
      groupId: session.groupId ?? session.group?.id,
      memberToken: session.memberToken
    })).filter((session) => session.groupId && session.memberToken);
    if (!sessions.length) throw new Error("备份中没有有效会话");
    const result = await importSessions(sessions);
    await loadAccountDashboard();
    $("#import-result").textContent = `浏览器备份已导入 ${result.imported} 个会话${result.rejected.length ? `，${result.rejected.length} 个已失效` : ""}。`;
    toast(`已导入 ${result.imported} 个浏览器会话`);
  } catch (error) {
    toast(error.message);
  }
}

async function waitForBrowserTransfer(transferToken) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await accountApi(`/api/account/browser-transfers/${transferToken}`);
    if (result.status === "pending") continue;
    if (result.status === "completed") {
      $("#import-result").textContent = `已从浏览器自动导入 ${result.imported} 个会话。`;
      await loadAccountDashboard();
      toast(`已导入 ${result.imported} 个会话`);
      return;
    }
    throw new Error(result.status === "expired" ? "浏览器导入已超时，请重试" : "浏览器中没有可导入的有效会话");
  }
  throw new Error("浏览器导入已超时，请重试");
}

$("#start-browser-transfer").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const nativeBridge = desktopNativeBridge();
  if (!nativeBridge) {
    const guidance = "请在 Group Relay 客户端选择“显示 → 在浏览器中打开”，网页会自动同步客户端账户和会话。";
    $("#import-result").textContent = guidance;
    toast("请从客户端打开网页进行自动同步");
    return;
  }
  button.disabled = true;
  $("#import-result").textContent = "正在打开浏览器…";
  try {
    const transfer = await accountApi("/api/account/browser-transfers", {
      method: "POST",
      body: "{}"
    });
    nativeBridge.postMessage({ action: "openExternal", url: transfer.transferUrl });
    $("#import-result").textContent = "浏览器已打开，正在等待自动导入…";
    await waitForBrowserTransfer(transfer.transferToken);
  } catch (error) {
    $("#import-result").textContent = error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#export-account").addEventListener("click", async () => {
  try {
    const { sessions } = await accountApi("/api/account/sessions");
    const backup = {
      format: "group-relay-account",
      version: 1,
      exportedAt: new Date().toISOString(),
      email: state.account.email,
      accountToken: state.accountToken,
      sessions: sessions.map((session) => ({
        groupId: session.group.id,
        groupName: session.group.name,
        memberToken: session.memberToken
      }))
    };
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `group-relay-${state.account.email.replace(/[^a-z0-9._-]/gi, "_")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("账户备份已下载，请安全保存");
  } catch (error) {
    toast(error.message);
  }
});

$("#import-account-file").addEventListener("change", handleBackupInput);

$("#account-logout").addEventListener("click", async () => {
  localStorage.removeItem(accountStorageKey);
  if (desktopNativeBridge()) await requestNative("deleteAccountCredential").catch(() => {});
  state.account = null;
  state.accountToken = null;
  clearInterval(state.taskRefreshTimer);
  state.taskRefreshTimer = null;
  try {
    await createAutomaticAccount();
    await loadAccountDashboard();
    toast("已重置并恢复本机群组");
  } catch (error) {
    toast(error.message);
  }
});

for (const button of document.querySelectorAll("[data-task-filter]")) {
  button.addEventListener("click", () => {
    state.taskFilter = button.dataset.taskFilter;
    document.querySelectorAll("[data-task-filter]").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === button);
    });
    renderAITasks();
  });
}

$("#refresh-ai-settings").addEventListener("click", () => { void loadAISettings(); });

$("#open-profile-settings").addEventListener("click", () => setOverviewView("settings"));

$("#edit-profile").addEventListener("click", () => {
  const form = $("#profile-settings-form");
  form.elements.displayName.value = form.dataset.savedName || accountEmailNickname(state.account);
  state.profileAvatarDataUrl = state.account?.avatarDataUrl ?? null;
  renderAvatar(
    "#profile-avatar-image",
    "#profile-avatar-fallback",
    state.profileAvatarDataUrl,
    form.elements.displayName.value
  );
  setProfileEditing(true);
});

$("#cancel-profile-edit").addEventListener("click", () => {
  const form = $("#profile-settings-form");
  const owner = form.dataset.savedName || accountEmailNickname(state.account);
  form.elements.displayName.value = owner;
  state.profileAvatarDataUrl = state.account?.avatarDataUrl ?? null;
  renderAvatar("#profile-avatar-image", "#profile-avatar-fallback", state.profileAvatarDataUrl, owner);
  setProfileEditing(false);
});

async function profileAvatarFromFile(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("头像只支持 PNG、JPEG 或 WebP");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("原始头像不能超过 5 MB");
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("无法读取这张图片"));
    });
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(source);
  }
}

$("#profile-avatar-input").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  try {
    state.profileAvatarDataUrl = await profileAvatarFromFile(file);
    const owner = $("#profile-settings-form [name=displayName]").value.trim() || "我";
    renderAvatar("#profile-avatar-image", "#profile-avatar-fallback", state.profileAvatarDataUrl, owner);
  } catch (error) {
    toast(error.message);
  }
});

$("#remove-profile-avatar").addEventListener("click", () => {
  state.profileAvatarDataUrl = null;
  const owner = $("#profile-settings-form [name=displayName]").value.trim() || "我";
  renderAvatar("#profile-avatar-image", "#profile-avatar-fallback", null, owner);
});

$("#profile-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const displayName = form.elements.displayName.value.trim();
  if (!displayName) return;
  form.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
  try {
    const { account } = await accountApi("/api/account", {
      method: "PATCH",
      body: JSON.stringify({ displayName, avatarDataUrl: state.profileAvatarDataUrl })
    });
    state.account = account;
    await loadAccountDashboard();
    toast("个人资料已保存，群聊名字已同步更新");
  } catch (error) {
    toast(error.message);
  } finally {
    form.querySelectorAll("input, button").forEach((control) => { control.disabled = false; });
  }
});

function closeAIKeyForm(form) {
  form.elements.apiKey.value = "";
  form.classList.add("hidden");
  form.closest(".ai-provider-card").querySelector(".toggle-ai-key").classList.remove("hidden");
}

for (const form of document.querySelectorAll(".ai-key-form")) {
  const toggle = form.closest(".ai-provider-card").querySelector(".toggle-ai-key");
  toggle.addEventListener("click", () => {
    toggle.classList.add("hidden");
    form.classList.remove("hidden");
    form.elements.apiKey.focus();
  });
  form.querySelector(".cancel-ai-key").addEventListener("click", () => closeAIKeyForm(form));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const provider = form.dataset.provider;
    const input = form.elements.apiKey;
    const apiKey = input.value.trim();
    if (!apiKey) {
      toast(`请输入 ${aiProviderLabels[provider]} API Key`);
      input.focus();
      return;
    }
    form.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
    try {
      const result = await requestNative("saveAIKey", { provider, apiKey });
      closeAIKeyForm(form);
      renderAISettings(result.providers ?? []);
      toast(`${aiProviderLabels[provider]} API Key 已安全保存`);
    } catch (error) {
      toast(error.message);
    } finally {
      form.querySelectorAll("input, button").forEach((control) => { control.disabled = false; });
      void loadAISettings();
    }
  });
  form.querySelector(".remove-ai-key").addEventListener("click", async () => {
    const provider = form.dataset.provider;
    form.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
    try {
      const result = await requestNative("deleteAIKey", { provider });
      closeAIKeyForm(form);
      renderAISettings(result.providers ?? []);
      toast(`${aiProviderLabels[provider]} API Key 已删除，将改用 CLI 登录`);
    } catch (error) {
      toast(error.message);
    } finally {
      form.querySelectorAll("input, button").forEach((control) => { control.disabled = false; });
      void loadAISettings();
    }
  });
}

for (const link of document.querySelectorAll("[data-overview-view]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setOverviewView(link.dataset.overviewView);
  });
}

window.addEventListener("hashchange", () => {
  if (!$("#account-dashboard").classList.contains("hidden")) {
    setOverviewView(overviewViewFromHash(), { updateHash: false });
  }
});

$("#refresh-ai-tasks").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await loadAccountTasks();
    toast("AI 看板已更新");
  } catch (error) {
    toast(error.message);
  } finally {
    event.currentTarget.disabled = false;
  }
});

function showAccountCreatePanel() {
  const panel = $("#account-create-panel");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#account-create-form [name=name]").focus();
}

$("#show-account-create").addEventListener("click", showAccountCreatePanel);
$("#show-account-create-inline").addEventListener("click", showAccountCreatePanel);

$("#cancel-account-create").addEventListener("click", () => {
  $("#account-create-panel").classList.add("hidden");
});

async function createGroup(formElement) {
  const form = new FormData(formElement);
  const result = await api("/api/groups", {
    method: "POST",
    body: JSON.stringify(Object.fromEntries(form))
  });
  state.groupId = result.group.id;
  state.token = result.member.token;
  state.inviteToken = result.group.inviteToken;
  saveSession();
  await linkCurrentSessionToAccount().catch(() => {});
  return result;
}

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await createGroup(event.currentTarget);
    history.replaceState({}, "", `/group/${state.groupId}`);
    showChatLoading(result.group.name);
    await navigator.clipboard?.writeText(result.inviteUrl).catch(() => {});
    await loadChat();
    toast("群组已创建，邀请链接已复制");
  } catch (error) {
    toast(error.message);
  }
});

$("#account-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await createGroup(event.currentTarget);
    history.replaceState({}, "", `/group/${state.groupId}`);
    showChatLoading(result.group.name);
    await navigator.clipboard?.writeText(result.inviteUrl).catch(() => {});
    await loadChat();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const input = {
    name: form.get("name"),
    type: "human",
    provider: null,
    ownerName: null
  };
  try {
    const result = await api(`/api/invites/${state.inviteToken}/join`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    state.groupId = result.group.id;
    state.token = result.member.token;
    saveSession();
    await linkCurrentSessionToAccount().catch(() => {});
    history.replaceState({}, "", `/group/${state.groupId}`);
    showChatLoading(result.group.name);
    await loadChat();
  } catch (error) {
    if (error.message === "invite not found") {
      await recoverLegacySession(state.inviteToken);
      return;
    }
    toast(error.message);
  }
});

$("#message-form [name=files]").addEventListener("change", (event) => {
  $("#file-count").textContent = event.target.files.length ? `${event.target.files.length} 个文件` : "";
});

function matchingMentionMembers(textarea) {
  const beforeCursor = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
  const match = beforeCursor.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match) return [];
  const query = match[1].trim().toLocaleLowerCase();
  if (/\s$/.test(match[1]) && state.members.some((member) => displayName(member).toLocaleLowerCase() === query)) {
    return [];
  }
  return state.members.filter((member) => displayName(member).toLocaleLowerCase().includes(query));
}

function renderMentionMenu() {
  const textarea = $("#message-form [name=text]");
  const menu = $("#mention-menu");
  const members = matchingMentionMembers(textarea);
  menu.innerHTML = "";
  for (const member of members) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mention-option";
    button.setAttribute("role", "option");
    button.textContent = `@${displayName(member)} · ${memberLabel(member)}`;
    button.addEventListener("click", () => insertMemberMention(member, { replaceActiveQuery: true }));
    menu.append(button);
  }
  menu.classList.toggle("hidden", members.length === 0);
}

$("#message-form [name=text]").addEventListener("input", renderMentionMenu);
$("#message-form [name=text]").addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("#mention-menu").classList.add("hidden");
  if (
    event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
  ) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
});

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  if (formElement.dataset.sending === "true") return;
  const form = new FormData(formElement);
  const text = String(form.get("text") || "");
  const files = form.getAll("files").filter((file) => file instanceof File && file.size > 0);
  if (!text.trim() && files.length === 0) return;
  const mentionIds = state.members
    .filter((member) => text.includes(`@${displayName(member)}`))
    .map((member) => member.id);
  form.set("mentions", JSON.stringify(mentionIds));
  formElement.dataset.sending = "true";
  const submitButton = formElement.querySelector("button[type=submit]");
  submitButton.disabled = true;
  try {
    const { message } = await api(`/api/groups/${state.groupId}/messages`, { method: "POST", body: form });
    renderMessage(message);
    formElement.reset();
    $("#mention-menu").classList.add("hidden");
    $("#file-count").textContent = "";
  } catch (error) {
    toast(error.message);
  } finally {
    formElement.dataset.sending = "false";
    submitButton.disabled = false;
  }
});

$("#invite-button").addEventListener("click", async () => {
  try {
    const inviteUrl = `${location.origin}/join/${state.inviteToken}`;
    await navigator.clipboard.writeText(inviteUrl);
    toast("邀请链接已复制");
  } catch (error) {
    toast(error.message);
  }
});

$("#back-to-groups").addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState({}, "", "/app#groups");
  stopChatRealtime();
  showAccountDashboardShell("groups");
  void showAccountView();
});

$("#chat-ai-settings").addEventListener("click", () => {
  history.replaceState({}, "", "/app#settings");
  stopChatRealtime();
  showAccountDashboardShell("settings");
  void showAccountView();
});

async function boot() {
  const nativeMacClient = navigator.userAgent.includes("GroupRelayMac/");
  const nativeWindowsClient = navigator.userAgent.includes("GroupRelayWindows/");
  const desktopMacBrowser = navigator.userAgent.includes("Macintosh") && !nativeMacClient;
  if (nativeMacClient || nativeWindowsClient) {
    $("#start-browser-transfer").textContent = "从浏览器导入会话";
    $("#client-tip-title").textContent = "一键从浏览器导入";
    $("#client-tip-text").textContent = "点击下方按钮会自动打开 Chrome；Chrome 读取自己的会话后自动传回客户端，无需下载或选择文件。";
  } else {
    $("#start-browser-transfer").textContent = "从客户端导入会话";
    $("#client-tip-title").textContent = desktopMacBrowser ? "客户端会话" : "桌面客户端会话";
    $("#client-tip-text").textContent = "在 Group Relay 客户端选择“显示 → 在浏览器中打开”，网页会自动同步相同的账户和会话。";
  }
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] === "transfer" && parts[1]) {
    show("#transfer-view");
    try {
      const sessions = localBrowserSessionCredentials();
      const response = await fetch(`/api/browser-transfers/${encodeURIComponent(parts[1])}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "浏览器会话导入失败");
      if (result.status === "completed") {
        $("#transfer-title").textContent = "会话已自动导入";
        $("#transfer-message").textContent = `已成功导入 ${result.imported} 个会话。即将返回 Group Relay 客户端。`;
        $(".transfer-loader").classList.add("complete");
        setTimeout(() => window.close(), 1500);
      } else {
        throw new Error("这个浏览器没有可导入的有效会话");
      }
    } catch (error) {
      $("#transfer-title").textContent = "无法导入会话";
      $("#transfer-message").textContent = error.message;
      $(".transfer-loader").classList.add("failed");
    }
    return;
  }
  if (parts[0] === "web-login" && parts[1]) {
    show("#transfer-view");
    $("#transfer-title").textContent = "正在同步桌面账户";
    $("#transfer-message").textContent = "正在安全读取客户端授权的昵称、群组和任务，请稍候…";
    try {
      const response = await fetch(`/api/web-logins/${encodeURIComponent(parts[1])}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "桌面账户同步失败");
      saveAccountCredential(result.account, result.accountToken);
      $("#transfer-title").textContent = "桌面账户已同步";
      $("#transfer-message").textContent = "昵称、群组和 AI 任务已载入，正在打开工作台…";
      $(".transfer-loader").classList.add("complete");
      history.replaceState({}, "", "/app");
      setTimeout(() => { void showAccountView(); }, 350);
    } catch (error) {
      $("#transfer-title").textContent = "无法同步桌面账户";
      $("#transfer-message").textContent = error.message;
      $(".transfer-loader").classList.add("failed");
    }
    return;
  }
  if (parts[0] === "app") {
    await showAccountView();
    return;
  }
  if (parts[0] === "join" && parts[1]) {
    state.inviteToken = parts[1];
    const mappedGroupId = localStorage.getItem(`relay-invite:${state.inviteToken}`);
    if (mappedGroupId && await resumeSession(mappedGroupId, state.inviteToken)) return;
    try {
      const { group } = await api(`/api/invites/${state.inviteToken}`);
      if (await resumeSession(group.id, state.inviteToken)) return;
      $("#join-title").textContent = `加入「${group.name}」`;
      show("#join-view");
    } catch (error) {
      if (error.message === "invite not found") {
        await recoverLegacySession(state.inviteToken);
        return;
      }
      showInvalidInvite();
      toast(error.message);
    }
    return;
  }
  if (parts[0] === "group" && parts[1]) {
    if (await resumeSession(parts[1])) return;
  }
  show("#create-view");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

boot();
