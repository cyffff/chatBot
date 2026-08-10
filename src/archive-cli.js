import { FileStore } from "./storage.js";

const store = new FileStore(process.env.GROUP_RELAY_DATA_DIR ?? "./data");
await store.init();
const count = await store.archiveOldMessages();
console.log(`Archived ${count} daily message file(s)`);
const purged = await store.purgeExpired({
  messageDays: Number(process.env.GROUP_RELAY_MESSAGE_RETENTION_DAYS ?? 30),
  attachmentHours: Number(process.env.GROUP_RELAY_ATTACHMENT_RETENTION_HOURS ?? 720)
});
console.log(`Purged ${Object.entries(purged).map(([key, value]) => `${value} ${key}`).join(", ")}`);
