import { t } from "./i18n.js";
// 聊天记录的长期副本存在本机,服务端只是 7 天的中转缓冲区。Mac 是 WKWebView、
// Windows 是 WebView2(带持久 userDataFolder),两端都用默认持久存储,所以这一份
// IndexedDB 实现同时覆盖网页和两个桌面客户端。
const databaseName = "group-relay-history";
const databaseVersion = 2;
const messageStore = "messages";
const syncStore = "sync";
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
  if (!historyAvailable()) throw new Error(t("这个浏览器不支持本地聊天记录存储"));
  const open = indexedDB.open(databaseName, databaseVersion);
  open.onupgradeneeded = () => {
    const database = open.result;
    if (!database.objectStoreNames.contains(messageStore)) {
      const store = database.createObjectStore(messageStore, { keyPath: "id" });
      // createdAt 是 ISO 字符串,字典序即时间序。
      store.createIndex(groupTimeIndex, ["groupId", "createdAt"]);
    }
    // v2:每个群记一个「上次追赶到哪个时刻」,重连后用它把错过的编辑要回来。
    if (!database.objectStoreNames.contains(syncStore)) {
      database.createObjectStore(syncStore, { keyPath: "groupId" });
    }
  };
  /// 另一个标签页还开着上一版的库时,升级请求会一直停在 blocked —— 既不成功也不失败。
  /// 干等的话调用方(打开群聊)就永远停在「正在进入群组」,所以这里必须变成一个错误。
  let abandoned = false;
  const opened = request(open).then((database) => {
    // blocked 之后才打开成功的连接不能留着:它会反过来把别的标签页卡在同一个地方。
    if (abandoned) {
      database.close();
      return null;
    }
    return database;
  });
  opened.catch(() => {});
  const database = await new Promise((resolve, reject) => {
    open.onblocked = () => {
      abandoned = true;
      reject(new Error(t("另一个标签页还开着旧版本的本机记录，关掉或刷新那一页就好")));
    };
    opened.then(resolve, reject);
  });
  if (!database) throw new Error(t("本机记录这次没打开成功，稍后再试"));
  connection = database;
  connection.onclose = () => { connection = null; };
  /// 下一次升版本时主动让路,否则这一页就是把别人卡住的那一页。
  connection.onversionchange = () => {
    connection?.close();
    connection = null;
  };
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

/// 看板上的任务标题和进展原来是服务端存的正文副本,现在按 id 回到本机记录里取。
export async function messagesByIds(ids) {
  const wanted = [...new Set((ids ?? []).filter(Boolean))];
  if (!wanted.length) return new Map();
  const database = await openHistory();
  const transaction = database.transaction(messageStore, "readonly");
  const store = transaction.objectStore(messageStore);
  const found = new Map();
  // 所有 get 都在同一个事务里同步发出,不能改成串行 await,否则事务会先自动关闭。
  await Promise.all(wanted.map(async (id) => {
    const message = await request(store.get(id));
    if (message) found.set(id, message);
  }));
  return found;
}

/// 「本地这份副本追赶到哪个时刻」。编辑不会产生新 id,所以按 id 的游标带不回它 ——
/// 重连和重开时把这个时刻交给服务端,才能把断线期间的改动补齐。
export async function syncPoint(groupId) {
  if (!groupId) return null;
  const database = await openHistory();
  const transaction = database.transaction(syncStore, "readonly");
  const row = await request(transaction.objectStore(syncStore).get(groupId));
  return row?.syncedAt ?? null;
}

/// 只前进不后退:轮询和首屏各自报自己的时刻,乱序到达时不能把已经追上的进度往回拨。
export async function saveSyncPoint(groupId, syncedAt) {
  if (!groupId || !syncedAt) return null;
  const database = await openHistory();
  const transaction = database.transaction(syncStore, "readwrite");
  const store = transaction.objectStore(syncStore);
  const row = await request(store.get(groupId));
  if (!row?.syncedAt || row.syncedAt < syncedAt) store.put({ groupId, syncedAt });
  await finished(transaction);
  return syncedAt;
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
    throw new Error(t("不是有效的 Group Relay 聊天记录文件"));
  }
  const imported = await saveMessages(payload.messages);
  const skipped = payload.messages.length - imported;
  return { imported, skipped };
}
