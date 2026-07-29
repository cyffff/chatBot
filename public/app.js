const $ = (selector) => document.querySelector(selector);
const state = {
  groupId: null,
  token: null,
  inviteToken: null,
  cursor: null,
  rendered: new Set(),
  realtimeStarted: false
};

const views = ["#create-view", "#join-view", "#chat-view"];
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
}

function memberLabel(member) {
  return member.type === "ai" ? member.provider : "真人";
}

function displayName(member) {
  if (member.type === "ai" && member.ownerName) {
    return `${member.ownerName}’s ${member.name}`;
  }
  return member.name;
}

function renderMembers(members) {
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
    meta.textContent = memberLabel(member);
    text.append(meta);
    item.append(avatar, text);
    $("#member-list").append(item);
  }
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
  state.rendered.add(message.id);
  state.cursor = message.id;
  const item = document.createElement("li");
  item.className = "message";
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
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

async function loadChat() {
  const [{ group, members }, { messages, cursor }] = await Promise.all([
    api(`/api/groups/${state.groupId}`),
    api(`/api/groups/${state.groupId}/messages?limit=200`)
  ]);
  $("#group-name").textContent = group.name;
  renderMembers(members);
  messages.forEach(renderMessage);
  state.cursor = cursor;
  show("#chat-view");
  startRealtime();
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
  events.addEventListener("member_joined", async () => {
    const { members } = await api(`/api/groups/${state.groupId}`);
    renderMembers(members);
  });
  events.onerror = () => {
    $("#connection").textContent = "备用连接";
  };
}

async function pollMessages() {
  while (state.groupId && state.token) {
    try {
      const query = new URLSearchParams({ timeoutMs: "25000", limit: "200" });
      if (state.cursor) query.set("after", state.cursor);
      const { messages } = await api(`/api/groups/${state.groupId}/messages/wait?${query}`);
      messages.forEach(renderMessage);
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

$("#join-form [name=type]").addEventListener("change", (event) => {
  const isAi = event.target.value === "ai";
  $("#provider-label").classList.toggle("hidden", !isAi);
  $("#owner-label").classList.toggle("hidden", !isAi);
  const ownerInput = $("#join-form [name=ownerName]");
  ownerInput.required = isAi;
  const nameInput = $("#join-form [name=name]");
  nameInput.placeholder = isAi ? "例如：Codex" : "你的名字";
  if (isAi && !nameInput.value) nameInput.value = "Codex";
});

$("#join-form [name=provider]").addEventListener("change", (event) => {
  const nameInput = $("#join-form [name=name]");
  const providerNames = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
  if (!nameInput.value || Object.values(providerNames).includes(nameInput.value)) {
    nameInput.value = providerNames[event.target.value];
  }
});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const input = Object.fromEntries(form);
  if (input.type !== "ai") {
    input.provider = null;
    input.ownerName = null;
  }
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
    toast(error.message);
  }
});

$("#message-form [name=files]").addEventListener("change", (event) => {
  $("#file-count").textContent = event.target.files.length ? `${event.target.files.length} 个文件` : "";
});

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const { message } = await api(`/api/groups/${state.groupId}/messages`, { method: "POST", body: form });
    renderMessage(message);
    event.currentTarget.reset();
    $("#file-count").textContent = "";
  } catch (error) {
    toast(error.message);
  }
});

$("#invite-button").addEventListener("click", async () => {
  try {
    const { inviteUrl } = await api(`/api/groups/${state.groupId}/invites/rotate`, { method: "POST" });
    state.inviteToken = inviteUrl.split("/").at(-1);
    await navigator.clipboard.writeText(inviteUrl);
    toast("新的邀请链接已复制");
  } catch (error) {
    toast(error.message);
  }
});

async function boot() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] === "join" && parts[1]) {
    state.inviteToken = parts[1];
    try {
      const { group } = await api(`/api/invites/${state.inviteToken}`);
      $("#join-title").textContent = `加入「${group.name}」`;
      show("#join-view");
    } catch (error) {
      show("#join-view");
      toast(error.message);
    }
    return;
  }
  if (parts[0] === "group" && parts[1]) {
    state.groupId = parts[1];
    const saved = JSON.parse(localStorage.getItem(`relay:${state.groupId}`) || "null");
    if (saved?.token) {
      state.token = saved.token;
      try {
        await loadChat();
        return;
      } catch {
        localStorage.removeItem(`relay:${state.groupId}`);
      }
    }
  }
  show("#create-view");
}

boot();
