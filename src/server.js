import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const { app, store, movedTo, pushEverythingToNewServer } = await createApp();

if (store.migration) {
  const { accounts, groups, legacyTokens, rewrittenRecords } = store.migration;
  console.log(
    `Migrated legacy data to email identity: ${accounts} accounts, ${groups} groups, `
    + `${rewrittenRecords} records re-keyed, ${legacyTokens} legacy tokens honoured `
    + "(delete data/legacy-tokens.json to end the grace period)"
  );
}

// 整机搬迁:把所有账号推给新服务器,之后客户端各自跟随。失败不阻止本机继续服务 ——
// 老服务器还得撑着,直到所有客户端都跟过去。
if (movedTo) {
  const result = await pushEverythingToNewServer();
  if (result?.error) {
    console.error(`Migration to ${movedTo} not started: ${result.error}`);
  } else if (result) {
    console.log(
      `Migrating to ${result.movedTo}: ${result.migrated}/${result.accounts} accounts pushed`
      + (result.failed.length ? `; failed: ${result.failed.join(", ")}` : "")
    );
    console.log("Clients will follow on their next /health check.");
  }
}

/// reusePort 让新旧两个进程能同时绑同一个端口,于是发布可以「先起新的、再停旧的」,
/// 端口一刻不空。以前每次 systemctl restart 都有一两秒没有 listener,cloudflared 拿到
/// connection refused 就对外回 502 —— 桥接在飞的 AI 任务会被打断并标成失败。
/// 老内核/老 Node 不认这个选项时退回普通监听,行为和以前一致。
const listenOptions = { port, host, reusePort: true };
const server = app.listen(listenOptions, () => {
  console.log(`Group Relay listening on http://${host}:${port}`);
});
server.on("error", (error) => {
  if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
  console.warn(`reusePort unsupported (${error.code}); falling back to a plain listen`);
  app.listen(port, host, () => {
    console.log(`Group Relay listening on http://${host}:${port}`);
  });
});

const messageDays = Number(process.env.GROUP_RELAY_MESSAGE_RETENTION_DAYS ?? 30);
const attachmentHours = Number(process.env.GROUP_RELAY_ATTACHMENT_RETENTION_HOURS ?? 720);

// 服务端只是中转缓冲区。每小时跑一次:先把昨天及更早的 JSONL 压成 .gz,再回收过了保留期的
// 消息、附件和已完结的审批/任务。长期副本在各人自己的客户端里。
const maintain = async () => {
  try {
    const count = await store.archiveOldMessages();
    if (count) console.log(`Archived ${count} daily message file(s)`);
  } catch (error) {
    console.error("Archive failed", error);
  }
  try {
    const purged = await store.purgeExpired({ messageDays, attachmentHours });
    const summary = Object.entries(purged).filter(([, count]) => count > 0);
    if (summary.length) {
      console.log(`Purged ${summary.map(([key, count]) => `${count} ${key}`).join(", ")}`);
    }
  } catch (error) {
    console.error("Purge failed", error);
  }
};

await maintain();
const maintenanceTimer = setInterval(maintain, 60 * 60 * 1000);

function shutdown() {
  clearInterval(maintenanceTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
