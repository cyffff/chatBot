#!/usr/bin/env node
/// 用缓冲区里的消息重算「我的 AI 干了多少活」的计数。
///
/// 计数是上线之后才开始累加的,而消息还在 30 天缓冲里 —— 不重算的话,已经干过的活要等一个
/// 月才看得出规模。做法是:对缓冲区里还有消息的那些天,按消息重算并**覆盖**对应的计数行;
/// 缓冲区已经没有的更早日期不动(那是长期存下来的部分)。因为是覆盖而不是累加,重复执行安全。
import fs from "node:fs/promises";
import path from "node:path";
import { FileStore } from "../src/storage.js";

const dataDir = process.env.GROUP_RELAY_DATA_DIR ?? "./data";
const store = new FileStore(dataDir);
await store.init();

const groups = (await fs.readdir(path.join(dataDir, "groups")).catch(() => []))
  .filter((name) => /^[0-9a-f-]{36}$/i.test(name));
if (!groups.length) {
  console.log("没有群目录,无需重算");
  process.exit(0);
}

const blank = () => ({
  asked: 0, answered: 0, failed: 0, replyChars: 0, attachments: 0,
  responseMsTotal: 0, responseSamples: 0
});

let touchedGroups = 0;
let totalAsked = 0;
for (const groupId of groups) {
  const members = await store.listMembers(groupId).catch(() => []);
  const aiIds = new Set(members.filter((member) => member.type === "ai").map((member) => member.id));
  if (!aiIds.size) continue;
  const messages = await store.readMessages(groupId, { limit: 500 }).catch(() => []);
  if (!messages.length) continue;

  // 问题 = @ 了本群某个 AI 的真人消息。回答 = 该 AI 发出的、replyTo 指着问题的终态消息,
  // 既包括新发一条,也包括被回写成终态的占位气泡。
  const questions = new Map();
  const recomputed = new Map();
  const days = new Set();
  const keyOf = (aiId, day, askerId) => `${aiId}\u0000${day}\u0000${askerId}`;
  for (const message of messages) {
    const day = (message.createdAt ?? "").slice(0, 10);
    if (!day) continue;
    const mentioned = (message.mentions ?? []).filter((mention) => aiIds.has(mention.id));
    if (message.sender?.type === "ai" || !mentioned.length) continue;
    days.add(day);
    questions.set(message.id, { message, day, mentioned });
    for (const ai of mentioned) {
      const key = keyOf(ai.id, day, message.sender?.id ?? "unknown");
      const row = recomputed.get(key) ?? {
        ...blank(),
        aiId: ai.id,
        groupId,
        day,
        askerId: message.sender?.id ?? "unknown",
        askerName: message.sender?.name ?? null
      };
      row.asked += 1;
      recomputed.set(key, row);
      totalAsked += 1;
    }
  }
  if (!recomputed.size) continue;

  for (const reply of messages) {
    if (reply.sender?.type !== "ai" || !aiIds.has(reply.sender.id)) continue;
    if (!reply.replyTo || reply.status === "processing") continue;
    const asked = questions.get(reply.replyTo);
    if (!asked) continue;
    const key = keyOf(reply.sender.id, asked.day, asked.message.sender?.id ?? "unknown");
    const row = recomputed.get(key);
    if (!row) continue;
    if (reply.status === "failed") row.failed += 1;
    else row.answered += 1;
    row.replyChars += (reply.text ?? "").length;
    row.attachments += (reply.attachments ?? []).length;
    const elapsed = Date.parse(reply.updatedAt ?? reply.createdAt) - Date.parse(asked.message.createdAt);
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      row.responseMsTotal += elapsed;
      row.responseSamples += 1;
    }
  }

  await store.updateAiWork((work) => {
    // 覆盖:先删掉这个群、这些天的旧行,再写入重算结果。
    work.rows = work.rows.filter((row) => !(row.groupId === groupId && days.has(row.day)));
    work.rows.push(...recomputed.values());
  });
  touchedGroups += 1;
  console.log(`重算 ${groupId}:${questions.size} 个问题,${recomputed.size} 行,${days.size} 天`);
}

console.log(`完成:${touchedGroups} 个群,共 ${totalAsked} 次被 @`);
