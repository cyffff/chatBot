import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { migrateLegacyData } from "./migrate-legacy.js";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const id = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(24).toString("base64url");
const normalizeEmail = (email) => String(email ?? "").trim().toLocaleLowerCase("en-US");
// 成员 id 由 email 推出来,所以服务端不需要保存任何 id → 身份的映射。
const humanMemberId = (email) => `human:${normalizeEmail(email)}`;
const aiMemberId = (email, provider) => `ai:${normalizeEmail(email)}:${provider}`;
const exportFormat = "group-relay-account-sync";
const dayOf = (iso = new Date().toISOString()) => iso.slice(0, 10);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${id()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

function parseJsonl(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function moveFile(source, target) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
}

async function removeIfEmpty(dir) {
  const remaining = await fs.readdir(dir).catch(() => ["keep"]);
  if (!remaining.length) await fs.rm(dir, { recursive: true, force: true });
}

export class FileStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.groupsDir = path.join(this.root, "groups");
    this.accountsFile = path.join(this.root, "accounts.json");
    this.uploadTempDir = path.join(this.root, "tmp", "uploads");
    this.groupsById = new Map();
    this.invitesByToken = new Map();
    this.presenceByMember = new Map();
    this.writeQueues = new Map();
    this.taskQueues = new Map();
    this.approvalQueues = new Map();
    this.accountQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.groupsDir, { recursive: true });
    await fs.mkdir(this.uploadTempDir, { recursive: true });
    if (!(await exists(this.accountsFile))) await writeJsonAtomic(this.accountsFile, {});
    // 旧格式(members.json / invites.json / 带 token 的账号)会在这里一次性转成
    // 按 email 归档的新格式,幂等,靠 marker 文件保证只跑一次。
    this.migration = await migrateLegacyData(this.root);
    this.legacyTokens = await readJson(path.join(this.root, "legacy-tokens.json")).catch(() => ({}));
    this.indexGroups(await this.accounts());
  }

  /// 迁移后的一次性宽限:旧客户端手里只有 token,拿它换回自己的 email,存下来之后
  /// 就再也不用了。删掉 data/legacy-tokens.json 即结束宽限期。
  emailForLegacyToken(token) {
    if (!token) return null;
    return this.legacyTokens?.[token] ?? null;
  }

  groupDir(groupId) {
    if (!/^[0-9a-f-]{36}$/i.test(groupId)) throw new Error("invalid group id");
    return path.join(this.groupsDir, groupId);
  }

  // ── 账号即身份 ───────────────────────────────────────────────────────────────
  // 远端只存 email、这个 email 创建的群组、以及它加入的群组 id。群成员名册不再是
  // 每群一份的 members.json,而是从所有账号里推导出来的;邀请 token → groupId 同理。
  // 成员 id 由 email 决定,所以不需要任何映射表:human:<email> / ai:<email>:<provider>。
  //
  // 没有鉴权:知道 email 和群 id 就能读写。这是明确的产品决定,不是遗漏。

  async accounts() {
    return readJson(this.accountsFile);
  }

  async updateAccounts(update) {
    const next = this.accountQueue.then(async () => {
      const accounts = await this.accounts();
      const result = await update(accounts);
      await writeJsonAtomic(this.accountsFile, accounts);
      this.indexGroups(accounts);
      return result;
    });
    this.accountQueue = next.catch(() => {});
    return next;
  }

  /// 群组和邀请 token 都散在各账号的 createdGroups 里,每次请求全表扫会很蠢,
  /// 所以写完就重建两张内存索引;accounts.json 仍是唯一真源。
  indexGroups(accounts) {
    this.groupsById = new Map();
    this.invitesByToken = new Map();
    for (const account of Object.values(accounts)) {
      for (const group of account.createdGroups ?? []) {
        this.groupsById.set(group.id, { ...group, ownerEmail: account.email });
        this.invitesByToken.set(group.inviteToken, group.id);
      }
    }
  }

  emailOf(value) {
    return normalizeEmail(value);
  }

  async ensureAccount(email, displayName) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return this.updateAccounts((accounts) => {
      const existing = accounts[normalized];
      if (existing) {
        if (displayName) existing.displayName = displayName;
        return existing;
      }
      const account = {
        email: normalized,
        displayName: displayName || normalized.split("@")[0],
        avatarDataUrl: null,
        createdAt: new Date().toISOString(),
        createdGroups: [],
        joinedGroups: [],
        ais: []
      };
      accounts[normalized] = account;
      return account;
    });
  }

  async accountByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return (await this.accounts())[normalized] ?? null;
  }

  async updateAccountProfile(email, profile) {
    return this.updateAccounts((accounts) => {
      const account = accounts[normalizeEmail(email)];
      if (!account) return null;
      account.displayName = profile.displayName;
      account.avatarDataUrl = profile.avatarDataUrl;
      account.updatedAt = new Date().toISOString();
      return account;
    });
  }

  /// 改昵称会影响这个 email 在所有群里的显示名和它名下 AI 的 ownerName —— 名册是
  /// 推导出来的,所以改一处就够,不需要遍历每个群去改副本。
  async renameAccount(email, displayName) {
    const account = await this.updateAccounts((accounts) => {
      const found = accounts[normalizeEmail(email)];
      if (!found) return null;
      found.displayName = displayName;
      return found;
    });
    if (!account) return [];
    return this.groupIdsFor(account).map((groupId) => ({ groupId, account }));
  }

  groupIdsFor(account) {
    // 去重是不变式:建群和加入两边理论上不该有同一个 id,真出现了也不该把群列两遍。
    return [...new Set([
      ...(account.createdGroups ?? []).map((group) => group.id),
      ...(account.joinedGroups ?? [])
    ])];
  }

  // ── 任务与审批(存 id 引用,不存正文)─────────────────────────────────────────

  async listTasks(groupId) {
    const file = path.join(this.groupDir(groupId), "tasks.json");
    if (!(await exists(file))) return [];
    return readJson(file);
  }

  async updateTasks(groupId, update) {
    const previous = this.taskQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const tasks = await this.listTasks(groupId);
      const result = await update(tasks);
      await writeJsonAtomic(path.join(this.groupDir(groupId), "tasks.json"), tasks);
      return result;
    });
    this.taskQueues.set(groupId, next.catch(() => {}));
    return next;
  }

  async listApprovals(groupId) {
    const file = path.join(this.groupDir(groupId), "approvals.json");
    if (!(await exists(file))) return [];
    return readJson(file);
  }

  async updateApprovals(groupId, update) {
    const previous = this.approvalQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const approvals = await this.listApprovals(groupId);
      const result = await update(approvals);
      await writeJsonAtomic(path.join(this.groupDir(groupId), "approvals.json"), approvals);
      return result;
    });
    this.approvalQueues.set(groupId, next.catch(() => {}));
    return next;
  }

  async createApproval(groupId, { aiMember, ownerMemberId, sourceMessage, summary }) {
    return this.updateApprovals(groupId, (approvals) => {
      const existing = approvals.find((approval) => (
        approval.status === "pending"
        && approval.aiMember.id === aiMember.id
        && approval.sourceMessageId === sourceMessage.id
      ));
      if (existing) return { approval: existing, created: false };
      const createdAt = new Date().toISOString();
      const approval = {
        id: id(),
        groupId,
        ownerMemberId,
        sourceMessageId: sourceMessage.id,
        // 只留 id 引用。原来这里内嵌了 text/sender/attachments 整份原文,那是消息内容存在
        // 服务端,而且会比保留期活得更久。要正文的地方按 id 从缓冲区(或客户端本地库)取。
        sender: { id: sourceMessage.sender.id, name: sourceMessage.sender.name },
        aiMember: {
          id: aiMember.id,
          name: aiMember.name,
          provider: aiMember.provider,
          ownerName: aiMember.ownerName ?? null
        },
        summary,
        status: "pending",
        createdAt,
        updatedAt: createdAt,
        resolvedAt: null
      };
      approvals.push(approval);
      return { approval, created: true };
    });
  }

  async resolveApproval(groupId, approvalId, ownerMemberId, status) {
    return this.updateApprovals(groupId, (approvals) => {
      const approval = approvals.find((candidate) => candidate.id === approvalId);
      if (!approval) return null;
      if (approval.ownerMemberId !== ownerMemberId) return { forbidden: true };
      if (approval.status !== "pending") return { approval, unchanged: true };
      approval.status = status;
      approval.updatedAt = new Date().toISOString();
      approval.resolvedAt = approval.updatedAt;
      return { approval };
    });
  }

  async createAssignmentTasks(groupId, message, assignees, jiraReferences) {
    if (!assignees.length || !jiraReferences.length) return [];
    return this.updateTasks(groupId, (tasks) => {
      const created = [];
      for (const jira of jiraReferences) {
        for (const assignee of assignees) {
          const duplicate = tasks.find((task) => (
            task.sourceMessageId === message.id
            && task.assignee.id === assignee.id
            && task.jira.url === jira.url
          ));
          if (duplicate) continue;
          const task = {
            id: id(),
            groupId,
            sourceMessageId: message.id,
            responseMessageId: null,
            // 只留 id 引用:标题和进展原来是消息正文的副本。看板文案由客户端按 id 从本机
            // 记录里取,取不到就退回 Jira key。
            jira: { key: jira.key, url: jira.url },
            assignee: {
              id: assignee.id,
              name: assignee.name,
              provider: assignee.provider,
              ownerName: assignee.ownerName ?? null
            },
            createdBy: {
              id: message.sender.id,
              name: message.sender.name
            },
            status: "assigned",
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
            startedAt: null,
            completedAt: null
          };
          tasks.push(task);
          created.push(task);
        }
      }
      return created;
    });
  }

  async updateAssignmentTasks(groupId, message) {
    if (message.sender?.type !== "ai") return [];
    return this.updateTasks(groupId, (tasks) => {
      const now = new Date().toISOString();
      const changed = [];
      for (const task of tasks) {
        const matchesSource = message.replyTo && task.sourceMessageId === message.replyTo;
        const matchesResponse = task.responseMessageId === message.id;
        if (task.assignee.id !== message.sender.id || (!matchesSource && !matchesResponse)) continue;
        task.responseMessageId = message.id;
        task.updatedAt = message.updatedAt ?? message.createdAt ?? now;
        if (message.status === "processing") {
          task.status = "in_progress";
          task.startedAt ??= now;
        } else {
          task.status = message.status === "failed" ? "failed" : "completed";
          task.startedAt ??= now;
          task.completedAt = now;
        }
        changed.push(task);
      }
      return changed;
    });
  }

  // ── 跨服务器同步 ────────────────────────────────────────────────────────────
  // 换服务器时要带走的「我的数据」= 账号本身 + 它建的群 + 加入的群 id + 名下的 AI。
  // 聊天记录不在里面:那份长期副本一直在客户端本地库里,跟着客户端走。

  async exportAccount(email) {
    const account = await this.accountByEmail(email);
    if (!account) return null;
    return {
      format: exportFormat,
      version: 1,
      exportedAt: new Date().toISOString(),
      account: {
        email: account.email,
        displayName: account.displayName,
        avatarDataUrl: account.avatarDataUrl ?? null,
        createdAt: account.createdAt
      },
      createdGroups: account.createdGroups ?? [],
      joinedGroups: account.joinedGroups ?? [],
      ais: account.ais ?? []
    };
  }

  /// 幂等合并。群必须保留原来的 id 和邀请 token —— 客户端本地记录、桌面 worker 配置和
  /// 已经发出去的邀请链接全都按 id 认群,重新生成等于把这些全断掉。
  /// 整机搬迁用:把每个账号都导一份。服务端自己就有全部账号,所以不需要每个人各自点一次,
  /// 也不会出现「成员先同步、群主还没过去」那种暂时看不到群的顺序问题。
  async exportAllAccounts() {
    const emails = Object.keys(await this.accounts());
    const payloads = [];
    for (const email of emails) {
      const payload = await this.exportAccount(email);
      if (payload) payloads.push(payload);
    }
    return payloads;
  }

  /// 旧的本机账号(device-…)回来登录时,把它名下的一切并到真正的邮箱账号:群、加入关系、
  /// 名下的 AI,连缓冲区里的成员 id 一起改写。不做的话这个人绑了邮箱也看不到自己的群 ——
  /// 那些群是挂在设备身份下的。
  async claimDeviceAccount(deviceEmail, targetEmail) {
    const from = normalizeEmail(deviceEmail);
    const to = normalizeEmail(targetEmail);
    if (!from || !to || from === to) return null;
    const accounts = await this.accounts();
    if (!accounts[from]) return null;
    await this.ensureAccount(to);

    const moved = { groups: 0, joined: 0, ais: 0, rewritten: 0 };
    const touchedGroups = new Set();
    const result = await this.updateAccounts((current) => {
      const source = current[from];
      const target = current[to];
      if (!source || !target) return null;
      for (const group of source.createdGroups) {
        // 这个群可能已经在目标账号的「加入」里(claim 之前他是以成员身份在里面的)。
        // 不摘掉的话建群和加入两处都有同一个 id,群列表会重复一条。
        target.joinedGroups = target.joinedGroups.filter((id) => id !== group.id);
        if (target.createdGroups.some((candidate) => candidate.id === group.id)) continue;
        target.createdGroups.push(group);
        touchedGroups.add(group.id);
        moved.groups += 1;
      }
      for (const groupId of source.joinedGroups) {
        const known = target.createdGroups.some((group) => group.id === groupId)
          || target.joinedGroups.includes(groupId);
        touchedGroups.add(groupId);
        if (known) continue;
        target.joinedGroups.push(groupId);
        moved.joined += 1;
      }
      for (const ai of source.ais) {
        touchedGroups.add(ai.groupId);
        const clash = target.ais
          .some((candidate) => candidate.groupId === ai.groupId && candidate.provider === ai.provider);
        if (clash) continue;
        target.ais.push(ai);
        moved.ais += 1;
      }
      // 设备账号留成空壳:删掉的话,还拿着它登录的客户端会直接 404,不如让它变成一个
      // 什么都没有的身份,绑定后的邮箱才是本体。
      source.createdGroups = [];
      source.joinedGroups = [];
      source.ais = [];
      return moved;
    });
    if (!result) return null;

    const renames = new Map([[humanMemberId(from), humanMemberId(to)]]);
    for (const provider of ["codex", "claude", "cursor"]) {
      renames.set(aiMemberId(from, provider), aiMemberId(to, provider));
    }
    for (const groupId of touchedGroups) {
      moved.rewritten += await this.rewriteMemberIds(groupId, renames);
    }
    return { from, to, ...moved };
  }

  /// 缓冲区里的消息、任务和审批都按成员 id 引用发言人和 @ 对象。身份换了不跟着改的话,
  /// 旧消息的 @mention 全部失配,AI 会把答过的再答一遍。
  async rewriteMemberIds(groupId, renames) {
    const swap = (value) => (typeof value === "string" ? renames.get(value) ?? value : value);
    let changed = 0;
    const messagesDir = path.join(this.groupDir(groupId), "messages");
    for (const name of await fs.readdir(messagesDir).catch(() => [])) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name)) continue;
      const file = path.join(messagesDir, name);
      const compressed = name.endsWith(".gz");
      const messages = await this.readMessageFile(file);
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
        if (message.approval?.targetMemberId && swap(message.approval.targetMemberId) !== message.approval.targetMemberId) {
          message.approval.targetMemberId = swap(message.approval.targetMemberId);
          touched = true;
        }
      }
      if (!touched) continue;
      const body = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
      await fs.writeFile(file, compressed ? await gzip(Buffer.from(body)) : body);
      changed += messages.length;
    }
    for (const name of ["tasks.json", "approvals.json"]) {
      const file = path.join(this.groupDir(groupId), name);
      const records = await readJson(file);
      if (!Array.isArray(records) || !records.length) continue;
      let touched = false;
      for (const record of records) {
        if (record.ownerMemberId && swap(record.ownerMemberId) !== record.ownerMemberId) {
          record.ownerMemberId = swap(record.ownerMemberId);
          touched = true;
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

  async importAccount(payload) {
    if (payload?.format !== exportFormat) throw new Error("not a Group Relay account export");
    const email = normalizeEmail(payload.account?.email);
    if (!email) throw new Error("export is missing an email");
    const result = await this.updateAccounts((accounts) => {
      const account = accounts[email] ?? {
        email,
        displayName: payload.account.displayName || email.split("@")[0],
        avatarDataUrl: payload.account.avatarDataUrl ?? null,
        createdAt: payload.account.createdAt ?? new Date().toISOString(),
        createdGroups: [],
        joinedGroups: [],
        ais: []
      };
      accounts[email] = account;
      account.displayName = payload.account.displayName || account.displayName;
      account.avatarDataUrl = payload.account.avatarDataUrl ?? account.avatarDataUrl;
      const counts = { groups: 0, joined: 0, ais: 0 };
      for (const group of payload.createdGroups ?? []) {
        if (!group?.id || !group?.inviteToken) continue;
        const existing = account.createdGroups.find((candidate) => candidate.id === group.id);
        if (existing) {
          existing.name = group.name ?? existing.name;
          existing.inviteToken = group.inviteToken;
          continue;
        }
        account.createdGroups.push({
          id: group.id,
          name: group.name ?? "",
          createdAt: group.createdAt ?? new Date().toISOString(),
          inviteToken: group.inviteToken
        });
        counts.groups += 1;
      }
      for (const groupId of payload.joinedGroups ?? []) {
        const known = account.createdGroups.some((group) => group.id === groupId)
          || account.joinedGroups.includes(groupId);
        if (known) continue;
        account.joinedGroups.push(groupId);
        counts.joined += 1;
      }
      for (const ai of payload.ais ?? []) {
        if (!ai?.groupId || !ai?.provider) continue;
        const existing = account.ais
          .find((candidate) => candidate.groupId === ai.groupId && candidate.provider === ai.provider);
        if (existing) {
          existing.name = ai.name ?? existing.name;
          existing.trusted = Boolean(ai.trusted);
          continue;
        }
        account.ais.push({
          groupId: ai.groupId,
          provider: ai.provider,
          name: ai.name ?? ai.provider,
          trusted: Boolean(ai.trusted),
          joinedAt: ai.joinedAt ?? new Date().toISOString()
        });
        counts.ais += 1;
      }
      return counts;
    });
    // 群的目录结构要先建出来,否则第一条消息落不下去。
    for (const group of payload.createdGroups ?? []) {
      if (!group?.id || !/^[0-9a-f-]{36}$/i.test(group.id)) continue;
      const dir = this.groupDir(group.id);
      await fs.mkdir(path.join(dir, "messages"), { recursive: true });
      await fs.mkdir(path.join(dir, "attachments"), { recursive: true });
      if (!(await exists(path.join(dir, "tasks.json")))) {
        await writeJsonAtomic(path.join(dir, "tasks.json"), []);
      }
      if (!(await exists(path.join(dir, "approvals.json")))) {
        await writeJsonAtomic(path.join(dir, "approvals.json"), []);
      }
    }
    return { email, ...result };
  }

  // ── 群组 ────────────────────────────────────────────────────────────────────

  async createGroup({ name, email, displayName }) {
    const account = await this.ensureAccount(email, displayName);
    if (!account) throw new Error("email is required to create a group");
    const groupId = id();
    const group = {
      id: groupId,
      name,
      createdAt: new Date().toISOString(),
      inviteToken: secret()
    };
    const dir = this.groupDir(groupId);
    await fs.mkdir(path.join(dir, "messages"), { recursive: true });
    await fs.mkdir(path.join(dir, "attachments"), { recursive: true });
    await writeJsonAtomic(path.join(dir, "tasks.json"), []);
    await writeJsonAtomic(path.join(dir, "approvals.json"), []);
    await this.updateAccounts((accounts) => {
      accounts[account.email].createdGroups.push(group);
    });
    return { group: this.groupWithOwner(groupId), owner: await this.memberFor(groupId, account.email) };
  }

  groupWithOwner(groupId) {
    const indexed = this.groupsById.get(groupId);
    if (!indexed) return null;
    const { ownerEmail, ...group } = indexed;
    // ownerMemberId 是从建群人的 email 推出来的,调用方不用知道 email 也能比对成员。
    return { ...group, ownerMemberId: humanMemberId(ownerEmail) };
  }

  async getGroup(groupId) {
    if (!/^[0-9a-f-]{36}$/i.test(groupId)) throw new Error("invalid group id");
    return this.groupWithOwner(groupId);
  }

  async groupFromInvite(inviteToken) {
    const groupId = this.invitesByToken.get(inviteToken);
    return groupId ? this.getGroup(groupId) : null;
  }

  async rotateInvite(groupId) {
    const indexed = this.groupsById.get(groupId);
    if (!indexed) return null;
    const inviteToken = secret();
    await this.updateAccounts((accounts) => {
      const group = accounts[indexed.ownerEmail]?.createdGroups
        ?.find((candidate) => candidate.id === groupId);
      if (group) group.inviteToken = inviteToken;
    });
    return inviteToken;
  }

  async joinGroup(inviteToken, { email, displayName }) {
    const group = await this.groupFromInvite(inviteToken);
    if (!group) return null;
    const account = await this.ensureAccount(email, displayName);
    if (!account) return null;
    await this.updateAccounts((accounts) => {
      const found = accounts[account.email];
      const alreadyIn = found.createdGroups.some((candidate) => candidate.id === group.id)
        || found.joinedGroups.includes(group.id);
      if (!alreadyIn) found.joinedGroups.push(group.id);
    });
    return { group, member: await this.memberFor(group.id, account.email) };
  }

  /// 会话迁移用:把一批群 id 挂到这个 email 下。没有 token 可搬,搬的就是这层关系。
  async linkGroups(email, groupIds) {
    return this.updateAccounts((accounts) => {
      const account = accounts[normalizeEmail(email)];
      if (!account) return null;
      for (const groupId of groupIds) {
        const alreadyIn = account.createdGroups.some((group) => group.id === groupId)
          || account.joinedGroups.includes(groupId);
        if (!alreadyIn) account.joinedGroups.push(groupId);
      }
      return account;
    });
  }

  async leaveGroup(groupId, email) {
    return this.updateAccounts((accounts) => {
      const account = accounts[normalizeEmail(email)];
      if (!account) return false;
      const before = account.joinedGroups.length + account.ais.length;
      account.joinedGroups = account.joinedGroups.filter((candidate) => candidate !== groupId);
      account.ais = account.ais.filter((ai) => ai.groupId !== groupId);
      return account.joinedGroups.length + account.ais.length !== before;
    });
  }

  // ── 成员(从账号推导,不落盘)──────────────────────────────────────────────────

  /// presence 和 activeMessageIds 只活在内存里:心跳 45 秒一次、超时 90 秒,本来就是
  /// 易失状态。放进 accounts.json 的话每次心跳都要整文件重写,9 个 worker 会把这台
  /// 1G 的机器写穿。服务重启后 worker 会在一轮心跳内自己报回来。
  livePresence(memberId) {
    let live = this.presenceByMember.get(memberId);
    if (!live) {
      live = { status: "online", lastSeenAt: new Date().toISOString(), activeMessageIds: [] };
      this.presenceByMember.set(memberId, live);
    }
    return live;
  }

  humanMember(account, groupId) {
    return {
      id: humanMemberId(account.email),
      name: account.displayName,
      type: "human",
      provider: null,
      email: account.email,
      groupId,
      joinedAt: account.createdAt
    };
  }

  aiMember(account, registration) {
    const memberId = aiMemberId(account.email, registration.provider);
    const live = this.livePresence(memberId);
    return {
      id: memberId,
      name: registration.name,
      type: "ai",
      provider: registration.provider,
      ownerName: account.displayName,
      email: account.email,
      groupId: registration.groupId,
      // 名下的人类成员就是它的主人;免审批开关记在注册项上。
      desktopOwnerAccountId: account.email,
      desktopOwnerMemberId: humanMemberId(account.email),
      trustedOwnerMemberId: registration.trusted ? humanMemberId(account.email) : null,
      activeMessageIds: live.activeMessageIds,
      presence: { status: live.status, lastSeenAt: live.lastSeenAt },
      joinedAt: registration.joinedAt
    };
  }

  async listMembers(groupId) {
    const accounts = await this.accounts();
    const members = [];
    for (const account of Object.values(accounts)) {
      if (this.groupIdsFor(account).includes(groupId)) {
        members.push(this.humanMember(account, groupId));
      }
      for (const registration of account.ais ?? []) {
        if (registration.groupId === groupId) members.push(this.aiMember(account, registration));
      }
    }
    return members;
  }

  /// 身份解析入口:email(+provider)决定是谁。provider 缺省即真人成员。
  async memberFor(groupId, email, provider = null) {
    const account = await this.accountByEmail(email);
    if (!account) return null;
    if (provider) {
      const registration = (account.ais ?? [])
        .find((ai) => ai.groupId === groupId && ai.provider === provider);
      return registration ? this.aiMember(account, registration) : null;
    }
    if (!this.groupIdsFor(account).includes(groupId)) return null;
    return this.humanMember(account, groupId);
  }

  async memberById(groupId, memberId) {
    return (await this.listMembers(groupId)).find((member) => member.id === memberId) ?? null;
  }

  async addDesktopAI(groupId, { name, provider, email, trusted = false }) {
    const account = await this.accountByEmail(email);
    if (!account) return null;
    const existing = (account.ais ?? [])
      .find((ai) => ai.groupId === groupId && ai.provider === provider);
    if (existing) return { member: this.aiMember(account, existing), created: false };
    const registration = {
      groupId,
      provider,
      name,
      trusted,
      joinedAt: new Date().toISOString()
    };
    await this.updateAccounts((accounts) => {
      accounts[account.email].ais.push(registration);
    });
    return { member: this.aiMember(await this.accountByEmail(email), registration), created: true };
  }

  async removeDesktopAI(groupId, email, provider) {
    return this.updateAccounts((accounts) => {
      const account = accounts[normalizeEmail(email)];
      if (!account) return false;
      const before = account.ais.length;
      account.ais = account.ais
        .filter((ai) => !(ai.groupId === groupId && ai.provider === provider));
      return account.ais.length !== before;
    });
  }

  async setTrustedExecution(groupId, email, provider, enabled) {
    const account = await this.updateAccounts((accounts) => {
      const found = accounts[normalizeEmail(email)];
      const registration = found?.ais
        ?.find((ai) => ai.groupId === groupId && ai.provider === provider);
      if (!registration) return null;
      registration.trusted = enabled;
      return found;
    });
    return account ? this.memberFor(groupId, email, provider) : null;
  }

  async updatePresence(groupId, memberId, status) {
    const member = await this.memberById(groupId, memberId);
    if (!member || member.type !== "ai") return null;
    const live = this.livePresence(memberId);
    live.status = status === "online" && live.activeMessageIds.length ? "busy" : status;
    live.lastSeenAt = new Date().toISOString();
    return { status: live.status, lastSeenAt: live.lastSeenAt };
  }

  async setMessageActivity(groupId, memberId, messageId, processing) {
    const member = await this.memberById(groupId, memberId);
    if (!member || member.type !== "ai") return null;
    const live = this.livePresence(memberId);
    const active = new Set(live.activeMessageIds);
    if (processing) active.add(messageId);
    else active.delete(messageId);
    live.activeMessageIds = [...active];
    live.status = live.activeMessageIds.length ? "busy" : "online";
    live.lastSeenAt = new Date().toISOString();
    return { status: live.status, lastSeenAt: live.lastSeenAt };
  }

  async saveAttachments(groupId, files) {
    const day = dayOf();
    const dir = path.join(this.groupDir(groupId), "attachments", day);
    await fs.mkdir(dir, { recursive: true });
    return Promise.all(
      files.map(async (file) => {
        const attachmentId = id();
        const safeName = path.basename(file.originalname).replace(/[^\p{L}\p{N}._ -]/gu, "_");
        const diskName = `${attachmentId}-${safeName}`;
        const target = path.join(dir, diskName);
        // 上传现在落盘再搬,不经过内存。file.buffer 分支留着给直接注入内存文件的调用方。
        if (file.path) await moveFile(file.path, target);
        else await fs.writeFile(target, file.buffer);
        return {
          id: attachmentId,
          name: safeName,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
          day,
          diskName,
          url: `/api/groups/${groupId}/attachments/${day}/${encodeURIComponent(diskName)}`
        };
      })
    );
  }

  async appendMessage(groupId, member, {
    text, attachments, replyTo, mentions = [], status = "complete", approval = null
  }) {
    const createdAt = new Date().toISOString();
    const message = {
      id: id(),
      groupId,
      sender: {
        id: member.id,
        name: member.name,
        type: member.type,
        provider: member.provider,
        ownerName: member.ownerName ?? null
      },
      text: text || "",
      attachments,
      mentions,
      replyTo: replyTo || null,
      status,
      approval,
      createdAt
    };
    const file = path.join(this.groupDir(groupId), "messages", `${dayOf(createdAt)}.jsonl`);
    const previous = this.writeQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(() => fs.appendFile(file, `${JSON.stringify(message)}\n`, "utf8"));
    this.writeQueues.set(groupId, next.catch(() => {}));
    await next;
    return message;
  }

  async updateMessage(groupId, messageId, memberId, { text, status }) {
    const previous = this.writeQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const files = (await this.messageFiles(groupId)).filter((file) => !file.endsWith(".gz")).reverse();
      for (const file of files) {
        const messages = parseJsonl(await fs.readFile(file, "utf8"));
        const message = messages.find((candidate) => candidate.id === messageId);
        if (!message) continue;
        if (message.sender?.id !== memberId) return { forbidden: true };
        if (typeof text === "string") message.text = text;
        message.status = status;
        message.updatedAt = new Date().toISOString();
        const temp = `${file}.${id()}.tmp`;
        await fs.writeFile(temp, `${messages.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
        await fs.rename(temp, file);
        return { message };
      }
      return null;
    });
    this.writeQueues.set(groupId, next.catch(() => {}));
    return next;
  }

  async failProcessingMessages(groupId, memberId, text) {
    const previous = this.writeQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const updated = [];
      const files = (await this.messageFiles(groupId)).filter((file) => !file.endsWith(".gz"));
      for (const file of files) {
        const messages = parseJsonl(await fs.readFile(file, "utf8"));
        let changed = false;
        for (const message of messages) {
          if (message.sender?.id !== memberId || message.status !== "processing") continue;
          message.text = text;
          message.status = "failed";
          message.updatedAt = new Date().toISOString();
          updated.push(message);
          changed = true;
        }
        if (!changed) continue;
        const temp = `${file}.${id()}.tmp`;
        await fs.writeFile(temp, `${messages.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
        await fs.rename(temp, file);
      }
      return updated;
    });
    this.writeQueues.set(groupId, next.catch(() => {}));
    return next;
  }

  async messageFiles(groupId) {
    const dir = path.join(this.groupDir(groupId), "messages");
    const names = await fs.readdir(dir);
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  }

  async readMessageFile(file) {
    const raw = await fs.readFile(file);
    const content = file.endsWith(".gz") ? (await gunzip(raw)).toString("utf8") : raw.toString("utf8");
    return parseJsonl(content);
  }

  async readMessages(groupId, { after, limit = 100 } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const files = await this.messageFiles(groupId);
    const messages = [];
    // 从最新的一天往回读,凑够 limit 或撞到游标就停。读全量再切尾的老做法挂在长轮询上,
    // 每个 worker 每 25 秒就把该群保留期内的每个 .gz 解压一遍。
    for (let index = files.length - 1; index >= 0; index -= 1) {
      const day = await this.readMessageFile(files[index]);
      messages.unshift(...day);
      // 游标落在更早的文件里(或已被清理)时可以停:那它比读到的都旧,结果就是"最新 limit 条",
      // 和读全量再切尾的答案一致。
      if (after && day.some((message) => message.id === after)) break;
      if (messages.length >= capped) break;
    }
    let start = 0;
    if (after) {
      const index = messages.findIndex((message) => message.id === after);
      if (index >= 0) start = index + 1;
    }
    return messages.slice(start).slice(-capped);
  }

  async history(groupId) {
    return (await this.messageFiles(groupId)).map((file) => {
      const name = path.basename(file);
      return {
        day: name.slice(0, 10),
        compressed: name.endsWith(".gz")
      };
    });
  }

  attachmentPath(groupId, day, diskName) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid day");
    if (path.basename(diskName) !== diskName) throw new Error("invalid attachment");
    return path.join(this.groupDir(groupId), "attachments", day, diskName);
  }

  async archiveOldMessages(now = new Date()) {
    const today = dayOf(now.toISOString());
    let archived = 0;
    const groupIds = await fs.readdir(this.groupsDir);
    for (const groupId of groupIds) {
      if (!/^[0-9a-f-]{36}$/i.test(groupId)) continue;
      const files = await this.messageFiles(groupId);
      for (const file of files) {
        const name = path.basename(file);
        if (!name.endsWith(".jsonl") || name.slice(0, 10) >= today) continue;
        const output = `${file}.gz`;
        if (await exists(output)) {
          await fs.unlink(file);
          continue;
        }
        await fs.writeFile(output, await gzip(await fs.readFile(file)));
        await fs.unlink(file);
        archived += 1;
      }
    }
    return archived;
  }

  /// 服务端只是中转缓冲区,消息的长期副本在各人自己的客户端里。这里按保留期回收:
  /// 消息 7 天、附件 48 小时(按文件 mtime,所以是真的 48 小时而非按天取整)、
  /// 已完结的审批和任务跟着消息一起走 —— 它们内嵌了消息原文,不能比消息活得更久。
  async purgeExpired({
    messageDays = 7,
    attachmentHours = 48,
    uploadTempHours = 1,
    now = new Date()
  } = {}) {
    const purged = { messageFiles: 0, attachments: 0, approvals: 0, tasks: 0, uploadTemp: 0 };
    const oldestDay = dayOf(new Date(now.getTime() - messageDays * 86_400_000).toISOString());
    const attachmentCutoff = now.getTime() - attachmentHours * 3_600_000;
    const contentCutoff = now.getTime() - messageDays * 86_400_000;
    const groupIds = await fs.readdir(this.groupsDir);
    for (const groupId of groupIds) {
      if (!/^[0-9a-f-]{36}$/i.test(groupId)) continue;
      for (const file of await this.messageFiles(groupId)) {
        if (path.basename(file).slice(0, 10) >= oldestDay) continue;
        await fs.unlink(file);
        purged.messageFiles += 1;
      }
      purged.attachments += await this.purgeAttachments(groupId, attachmentCutoff);
      purged.approvals += await this.purgeResolved(
        groupId,
        (update) => this.updateApprovals(groupId, update),
        () => this.listApprovals(groupId),
        (approval) => approval.status !== "pending" && this.olderThan(approval, contentCutoff)
      );
      purged.tasks += await this.purgeResolved(
        groupId,
        (update) => this.updateTasks(groupId, update),
        () => this.listTasks(groupId),
        (task) => (task.status === "completed" || task.status === "failed")
          && this.olderThan(task, contentCutoff)
      );
    }
    purged.uploadTemp = await this.purgeUploadTemp(now.getTime() - uploadTempHours * 3_600_000);
    return purged;
  }

  olderThan(record, cutoff) {
    return Date.parse(record.updatedAt ?? record.createdAt) <= cutoff;
  }

  /// 先读一遍确认真有过期项再走写队列,否则每小时都会给每个群重写一次(甚至凭空建出)
  /// approvals.json 和 tasks.json。
  async purgeResolved(groupId, runUpdate, list, isExpired) {
    const current = await list().catch(() => []);
    if (!current.some(isExpired)) return 0;
    return runUpdate((records) => {
      const kept = records.filter((record) => !isExpired(record));
      const removed = records.length - kept.length;
      records.splice(0, records.length, ...kept);
      return removed;
    }).catch(() => 0);
  }

  async purgeAttachments(groupId, cutoff) {
    const root = path.join(this.groupDir(groupId), "attachments");
    let removed = 0;
    for (const day of await fs.readdir(root).catch(() => [])) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const dir = path.join(root, day);
      for (const name of await fs.readdir(dir).catch(() => [])) {
        const file = path.join(dir, name);
        const stats = await fs.stat(file).catch(() => null);
        if (!stats?.isFile() || stats.mtimeMs > cutoff) continue;
        await fs.unlink(file);
        removed += 1;
      }
      await removeIfEmpty(dir);
    }
    return removed;
  }

  /// multer 落盘后如果请求中途失败,临时文件不会自己消失。
  async purgeUploadTemp(cutoff) {
    let removed = 0;
    for (const name of await fs.readdir(this.uploadTempDir).catch(() => [])) {
      const file = path.join(this.uploadTempDir, name);
      const stats = await fs.stat(file).catch(() => null);
      if (!stats?.isFile() || stats.mtimeMs > cutoff) continue;
      await fs.unlink(file);
      removed += 1;
    }
    return removed;
  }
}
