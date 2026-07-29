import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const { app, store } = await createApp();

const server = app.listen(port, host, () => {
  console.log(`Group Relay listening on http://${host}:${port}`);
});

const archive = async () => {
  try {
    const count = await store.archiveOldMessages();
    if (count) console.log(`Archived ${count} daily message file(s)`);
  } catch (error) {
    console.error("Archive failed", error);
  }
};

await archive();
const archiveTimer = setInterval(archive, 60 * 60 * 1000);

function shutdown() {
  clearInterval(archiveTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
