import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const { app, store } = await createApp();

const server = app.listen(port, host, () => {
  console.log(`Group Relay listening on http://${host}:${port}`);
});

const messageDays = Number(process.env.GROUP_RELAY_MESSAGE_RETENTION_DAYS ?? 7);
const attachmentHours = Number(process.env.GROUP_RELAY_ATTACHMENT_RETENTION_HOURS ?? 48);

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
