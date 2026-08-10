// 聊天记录的长期副本存在本机,服务端只是 7 天的中转缓冲区。Mac 是 WKWebView、
// Windows 是 WebView2(带持久 userDataFolder),两端都用默认持久存储,所以这一份
// IndexedDB 实现同时覆盖网页和两个桌面客户端。
const databaseName = "group-relay-history";
const databaseVersion = 1;
const messageStore = "messages";
const groupTimeIndex = "group_time";
const exportFormat = "group-relay-history";

let connection = null;

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}

export function historyAvailable() {
  return typeof indexedDB !== "undefined";
}

export async function openHistory() {
  if (connection) return connection;
  if (!historyAvailable()) throw new Error("这个浏览器不支持本地聊天记录存储");
  const open = indexedDB.open(databaseName, databaseVersion);
  open.onupgradeneeded = () => {
    const database = open.result;
    if (database.objectStoreNames.contains(messageStore)) return;
    const store = database.createObjectStore(messageStore, { keyPath: "id" });
    // createdAt 是 ISO 字符串,字典序即时间序。
    store.createIndex(groupTimeIndex, ["groupId", "createdAt"]);
  };
  connection = await request(open);
  connection.onclose = () => { connection = null; };
  return connection;
}

/// 幂等 upsert:同一条消息重复到达(轮询和 SSE 都会送)或被改写(processing → complete)
/// 都是覆盖写,所以调用方不需要先查。
export async function saveMessages(messages) {
  const rows = (Array.isArray(messages) ? messages : [messages])
    .filter((message) => message?.id && message?.groupId && message?.createdAt);
  if (!rows.length) return 0;
  const database = await openHistory();
  const transaction = database.transaction(messageStore, "readwrite");
  const store = transaction.objectStore(messageStore);
  for (const message of rows) store.put(message);
  await finished(transaction);
  return rows.length;
}

/// 取某个群最近的 limit 条,按时间正序返回。用游标从新往旧走再反转,不把整个群读进内存。
export async function recentMessages(groupId, limit = 200) {
  if (!groupId) return [];
  const database = await openHistory();
  const transaction = database.transaction(messageStore, "readonly");
  const index = transaction.objectStore(messageStore).index(groupTimeIndex);
  const range = IDBKeyRange.bound([groupId, ""], [groupId, "￿"]);
  const newestFirst = [];
  await new Promise((resolve, reject) => {
    const cursor = index.openCursor(range, "prev");
    cursor.onsuccess = () => {
      const position = cursor.result;
      if (!position || newestFirst.length >= limit) return resolve();
      newestFirst.push(position.value);
      position.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return newestFirst.reverse();
}

export async function latestMessageId(groupId) {
  const [latest] = await recentMessages(groupId, 1);
  return latest?.id ?? null;
}

export async function historyStats() {
  const database = await openHistory();
  const transaction = database.transaction(messageStore, "readonly");
  const store = transaction.objectStore(messageStore);
  const total = await request(store.count());
  const groups = new Set();
  await new Promise((resolve, reject) => {
    const cursor = store.index(groupTimeIndex).openKeyCursor();
    cursor.onsuccess = () => {
      const position = cursor.result;
      if (!position) return resolve();
      groups.add(position.key[0]);
      position.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return { messages: total, groups: groups.size };
}

/// 换机器时的回溯手段:服务端过了保留期就没有历史了,导出文件是唯一的搬运方式。
export async function exportHistory() {
  const database = await openHistory();
  const transaction = database.transaction(messageStore, "readonly");
  const messages = await request(transaction.objectStore(messageStore).getAll());
  messages.sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
  return {
    format: exportFormat,
    version: 1,
    exportedAt: new Date().toISOString(),
    messages
  };
}

export async function importHistory(payload) {
  if (payload?.format !== exportFormat || !Array.isArray(payload.messages)) {
    throw new Error("不是有效的 Group Relay 聊天记录文件");
  }
  const imported = await saveMessages(payload.messages);
  const skipped = payload.messages.length - imported;
  return { imported, skipped };
}
