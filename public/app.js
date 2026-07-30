const $ = (selector) => document.querySelector(selector);
const state = {
  groupId: null,
  token: null,
  inviteToken: null,
  cursor: null,
  rendered: new Set(),
  realtimeStarted: false,
  presenceRefreshStarted: false,
  memberId: null,
  members: []
};

const views = ["#create-view", "#join-view", "#invalid-view", "#chat-view"];
function show(selector) {
  views.forEach((view) => $(view).classList.toggle("hidden", view !== selector));
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  setTimeout(() => element.classList.remove("visible"), 1800);
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
    item.append(avatar, text);
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
  if (eventName === "member_joined") return refreshMembers();
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
  if (message.text) {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.text;
    item.append(bubble);
  }
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
  const [{ group, members, currentMemberId }, { messages, cursor }] = await Promise.all([
    api(`/api/groups/${state.groupId}`),
    api(`/api/groups/${state.groupId}/messages?limit=200`)
  ]);
  state.inviteToken = group.inviteToken;
  state.memberId = currentMemberId;
  $("#group-name").textContent = group.name;
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
}

async function refreshMembers() {
  const { members } = await api(`/api/groups/${state.groupId}`);
  renderMembers(members);
}

function startPresenceRefresh() {
  if (state.presenceRefreshStarted) return;
  state.presenceRefreshStarted = true;
  setInterval(() => refreshMembers().catch(() => {}), 30_000);
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
  const events = new EventSource(`/api/groups/${state.groupId}/events?token=${encodeURIComponent(state.token)}`);
  events.addEventListener("ready", markConnected);
  events.addEventListener("message", (event) => renderMessage(JSON.parse(event.data)));
  for (const eventName of ["member_joined", "member_left", "member_presence"]) {
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
      const query = new URLSearchParams({ timeoutMs: "25000", limit: "200" });
      if (state.cursor) query.set("after", state.cursor);
      const { messages, event, eventPayload } = await api(`/api/groups/${state.groupId}/messages/wait?${query}`);
      messages.forEach(renderMessage);
      if (event && event !== "message" && eventPayload) {
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

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form))
    });
    state.groupId = result.group.id;
    state.token = result.member.token;
    state.inviteToken = result.group.inviteToken;
    saveSession();
    history.replaceState({}, "", `/group/${state.groupId}`);
    await navigator.clipboard?.writeText(result.inviteUrl);
    await loadChat();
    toast("群组已创建，邀请链接已复制");
  } catch (error) {
    toast(error.message);
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
    history.replaceState({}, "", `/group/${state.groupId}`);
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

function matchingAiMembers(text) {
  const match = text.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match) return [];
  const query = match[1].trim().toLocaleLowerCase();
  return state.members.filter((member) => (
    member.type === "ai" && displayName(member).toLocaleLowerCase().includes(query)
  ));
}

function renderMentionMenu() {
  const textarea = $("#message-form [name=text]");
  const menu = $("#mention-menu");
  const members = matchingAiMembers(textarea.value);
  menu.innerHTML = "";
  for (const member of members) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mention-option";
    button.setAttribute("role", "option");
    button.textContent = `@${displayName(member)}`;
    button.addEventListener("click", () => {
      textarea.value = textarea.value.replace(/(^|\s)@[^@\n]*$/, `$1@${displayName(member)} `);
      menu.classList.add("hidden");
      textarea.focus();
    });
    menu.append(button);
  }
  menu.classList.toggle("hidden", members.length === 0);
}

$("#message-form [name=text]").addEventListener("input", renderMentionMenu);
$("#message-form [name=text]").addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("#mention-menu").classList.add("hidden");
});

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const text = String(form.get("text") || "");
  const mentionIds = state.members
    .filter((member) => member.type === "ai" && text.includes(`@${displayName(member)}`))
    .map((member) => member.id);
  form.set("mentions", JSON.stringify(mentionIds));
  try {
    const { message } = await api(`/api/groups/${state.groupId}/messages`, { method: "POST", body: form });
    renderMessage(message);
    formElement.reset();
    $("#mention-menu").classList.add("hidden");
    $("#file-count").textContent = "";
  } catch (error) {
    toast(error.message);
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

async function boot() {
  const parts = location.pathname.split("/").filter(Boolean);
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

boot();
