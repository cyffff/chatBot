import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const marker = "migrated-email-identity.json";
const normalizeEmail = (email) => String(email ?? "").trim().toLocaleLowerCase("en-US");
const humanMemberId = (email) => `human:${normalizeEmail(email)}`;
const aiMemberId = (email, provider) => `ai:${normalizeEmail(email)}:${provider}`;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

/// 没有账号的历史成员(只在浏览器里存过成员 token 的人)也不能丢:给一个可识别的
/// 占位 email,并把他的旧 token 记进 legacy-tokens.json,下次请求就能自动换成 email。
function placeholderEmail(member) {
  const slug = String(member.name ?? "member")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "") || "member";
  return `${slug}.${member.id.slice(0, 8)}@legacy.group-relay.local`;
}

function emptyAccount(email, displayName, createdAt) {
  return {
    email,
    displayName: displayName || email.split("@")[0],
    avatarDataUrl: null,
    createdAt: createdAt ?? new Date().toISOString(),
    createdGroups: [],
    joinedGroups: [],
    ais: []
  };
}

/// 旧格式:accounts.json 里每个账号带 id/token/memberships,群成员在
/// groups/<id>/members.json,邀请在 invites.json。新格式只有一个按 email 归档的
/// accounts.json。这个函数是一次性的、幂等的(靠 marker 文件)。
export async function migrateLegacyData(root) {
  const markerFile = path.join(root, marker);
  if (await exists(markerFile)) return null;

  const accountsFile = path.join(root, "accounts.json");
  const invitesFile = path.join(root, "invites.json");
  const groupsDir = path.join(root, "groups");
  const legacyAccounts = await readJson(accountsFile, {}) ?? {};
  const legacyAccountList = Object.values(legacyAccounts)
    .filter((account) => account && typeof account === "object" && account.id && account.token);
  const groupIds = (await fs.readdir(groupsDir).catch(() => []))
    .filter((name) => /^[0-9a-f-]{36}$/i.test(name));
  const legacyGroups = [];
  for (const groupId of groupIds) {
    const group = await readJson(path.join(groupsDir, groupId, "group.json"));
    const members = await readJson(path.join(groupsDir, groupId, "members.json"), []);
    if (group && Array.isArray(members)) legacyGroups.push({ groupId, group, members });
  }
  if (!legacyAccountList.length && !legacyGroups.length) {
    await writeJsonAtomic(markerFile, { migratedAt: new Date().toISOString(), accounts: 0, groups: 0 });
    return null;
  }

  const accounts = {};
  const emailByAccountId = new Map();
  const emailByMemberId = new Map();
  const emailByToken = new Map();
  const newIdByOldId = new Map();

  for (const legacy of legacyAccountList) {
    const email = normalizeEmail(legacy.normalizedEmail ?? legacy.email);
    if (!email) continue;
    const account = accounts[email] ?? emptyAccount(email, legacy.displayName, legacy.createdAt);
    account.avatarDataUrl = legacy.avatarDataUrl ?? account.avatarDataUrl;
    accounts[email] = account;
    emailByAccountId.set(legacy.id, email);
    if (legacy.token) emailByToken.set(legacy.token, email);
    for (const membership of legacy.memberships ?? []) {
      if (membership.memberId) emailByMemberId.set(membership.memberId, email);
      if (membership.memberToken) emailByToken.set(membership.memberToken, email);
    }
  }

  // 先把所有成员的归属确定下来,再决定群挂在谁名下 —— 群主可能是个没有账号的人。
  for (const { members } of legacyGroups) {
    for (const member of members) {
      if (member.type !== "human") continue;
      let email = emailByMemberId.get(member.id);
      if (!email) {
        email = placeholderEmail(member);
        emailByMemberId.set(member.id, email);
        accounts[email] ??= emptyAccount(email, member.name, member.joinedAt);
      }
      accounts[email] ??= emptyAccount(email, member.name, member.joinedAt);
      if (member.name && accounts[email].displayName !== member.name) {
        accounts[email].displayName = member.name;
      }
      if (member.token) emailByToken.set(member.token, email);
      newIdByOldId.set(member.id, humanMemberId(email));
    }
  }

  for (const { groupId, group, members } of legacyGroups) {
    const ownerEmail = emailByMemberId.get(group.ownerMemberId)
      ?? emailByMemberId.get(members.find((member) => member.type === "human")?.id);
    const record = {
      id: groupId,
      name: group.name,
      createdAt: group.createdAt,
      inviteToken: group.inviteToken
    };
    if (ownerEmail) {
      accounts[ownerEmail].createdGroups.push(record);
    } else {
      // 群主已经不在名册里:挂到一个占位账号下,否则整个群连邀请链接都查不到。
      const orphan = `orphan.${groupId.slice(0, 8)}@legacy.group-relay.local`;
      accounts[orphan] ??= emptyAccount(orphan, group.name, group.createdAt);
      accounts[orphan].createdGroups.push(record);
    }
    for (const member of members) {
      if (member.type === "human") {
        const email = emailByMemberId.get(member.id);
        if (!email || email === ownerEmail) continue;
        if (!accounts[email].joinedGroups.includes(groupId)) {
          accounts[email].joinedGroups.push(groupId);
        }
        continue;
      }
      if (member.type !== "ai" || !member.provider) continue;
      const ownerOfAi = emailByAccountId.get(member.desktopOwnerAccountId)
        ?? emailByMemberId.get(member.desktopOwnerMemberId)
        ?? emailByMemberId.get(member.trustedOwnerMemberId)
        ?? ownerEmail;
      if (!ownerOfAi) continue;
      accounts[ownerOfAi] ??= emptyAccount(ownerOfAi, member.ownerName, member.joinedAt);
      const already = accounts[ownerOfAi].ais
        .some((ai) => ai.groupId === groupId && ai.provider === member.provider);
      if (!already) {
        accounts[ownerOfAi].ais.push({
          groupId,
          provider: member.provider,
          name: member.name,
          trusted: Boolean(member.trustedOwnerMemberId),
          joinedAt: member.joinedAt
        });
      }
      if (member.token) emailByToken.set(member.token, ownerOfAi);
      newIdByOldId.set(member.id, aiMemberId(ownerOfAi, member.provider));
    }
  }

  // 缓冲区里的消息带着旧的 uuid 成员 id。不换掉的话 @mention 全部对不上,
  // 部署后头几小时 AI 会把已经答过的消息当成新的再答一遍。
  let rewritten = 0;
  for (const groupId of groupIds) {
    rewritten += await rewriteGroupIds(path.join(groupsDir, groupId), newIdByOldId);
  }

  await writeJsonAtomic(accountsFile, accounts);
  await writeJsonAtomic(path.join(root, "legacy-tokens.json"), Object.fromEntries(emailByToken));
  // 旧文件留成 .legacy 备份,不删 —— 迁移错了还能回头看。
  if (await exists(invitesFile)) await fs.rename(invitesFile, `${invitesFile}.legacy`);
  for (const groupId of groupIds) {
    for (const name of ["group.json", "members.json"]) {
      const file = path.join(groupsDir, groupId, name);
      if (await exists(file)) await fs.rename(file, `${file}.legacy`);
    }
  }
  const summary = {
    migratedAt: new Date().toISOString(),
    accounts: Object.keys(accounts).length,
    groups: legacyGroups.length,
    legacyTokens: emailByToken.size,
    rewrittenRecords: rewritten
  };
  await writeJsonAtomic(markerFile, summary);
  return summary;
}

async function rewriteGroupIds(groupDir, newIdByOldId) {
  const swap = (value) => (typeof value === "string" ? newIdByOldId.get(value) ?? value : value);
  let changed = 0;

  const messagesDir = path.join(groupDir, "messages");
  for (const name of await fs.readdir(messagesDir).catch(() => [])) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name)) continue;
    const file = path.join(messagesDir, name);
    const compressed = name.endsWith(".gz");
    const raw = await fs.readFile(file);
    const text = compressed ? (await gunzip(raw)).toString("utf8") : raw.toString("utf8");
    const messages = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let touched = false;
    for (const message of messages) {
      if (message.sender?.id && swap(message.sender.id) !== message.sender.id) {
        message.sender.id = swap(message.sender.id);
        touched = true;
      }
      for (const mention of message.mentions ?? []) {
        if (swap(mention.id) !== mention.id) {
          mention.id = swap(mention.id);
          touched = true;
        }
      }
      if (message.approval?.targetMemberId) {
        const next = swap(message.approval.targetMemberId);
        if (next !== message.approval.targetMemberId) {
          message.approval.targetMemberId = next;
          touched = true;
        }
      }
    }
    if (!touched) continue;
    const body = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    await fs.writeFile(file, compressed ? await gzip(Buffer.from(body)) : body);
    changed += messages.length;
  }

  for (const name of ["tasks.json", "approvals.json"]) {
    const file = path.join(groupDir, name);
    const records = await readJson(file);
    if (!Array.isArray(records) || !records.length) continue;
    let touched = false;
    for (const record of records) {
      for (const key of ["ownerMemberId"]) {
        if (record[key] && swap(record[key]) !== record[key]) {
          record[key] = swap(record[key]);
          touched = true;
        }
      }
      for (const key of ["assignee", "createdBy", "aiMember", "sender"]) {
        if (record[key]?.id && swap(record[key].id) !== record[key].id) {
          record[key].id = swap(record[key].id);
          touched = true;
        }
      }
    }
    if (touched) {
      await writeJsonAtomic(file, records);
      changed += records.length;
    }
  }
  return changed;
}
