import { FileStore } from "./storage.js";

const store = new FileStore(process.env.GROUP_RELAY_DATA_DIR ?? "./data");
await store.init();
const count = await store.archiveOldMessages();
console.log(`Archived ${count} daily message file(s)`);
