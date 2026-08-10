import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const id = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(24).toString("base64url");
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
    this.invitesFile = path.join(this.root, "invites.json");
    this.accountsFile = path.join(this.root, "accounts.json");
    this.uploadTempDir = path.join(this.root, "tmp", "uploads");
    this.writeQueues = new Map();
    this.memberQueues = new Map();
    this.taskQueues = new Map();
    this.approvalQueues = new Map();
    this.accountQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.groupsDir, { recursive: true });
    await fs.mkdir(this.uploadTempDir, { recursive: true });
    if (!(await exists(this.invitesFile))) await writeJsonAtomic(this.invitesFile, {});
    if (!(await exists(this.accountsFile))) await writeJsonAtomic(this.accountsFile, {});
  }

  groupDir(groupId) {
    if (!/^[0-9a-f-]{36}$/i.test(groupId)) throw new Error("invalid group id");
    return path.join(this.groupsDir, groupId);
  }

  async createGroup({ name, ownerName }) {
    const groupId = id();
    const inviteToken = secret();
    const owner = {
      id: id(),
      name: ownerName,
      type: "human",
      provider: null,
      token: secret(),
      joinedAt: new Date().toISOString()
    };
    const group = {
      id: groupId,
      name,
      createdAt: new Date().toISOString(),
      inviteToken,
      ownerMemberId: owner.id
    };
    const dir = this.groupDir(groupId);
    await fs.mkdir(path.join(dir, "messages"), { recursive: true });
    await fs.mkdir(path.join(dir, "attachments"), { recursive: true });
    await writeJsonAtomic(path.join(dir, "group.json"), group);
    await writeJsonAtomic(path.join(dir, "members.json"), [owner]);
    await writeJsonAtomic(path.join(dir, "tasks.json"), []);
    await writeJsonAtomic(path.join(dir, "approvals.json"), []);
    const invites = await readJson(this.invitesFile);
    invites[inviteToken] = groupId;
    await writeJsonAtomic(this.invitesFile, invites);
    return { group, owner };
  }

  async groupFromInvite(inviteToken) {
    const invites = await readJson(this.invitesFile);
    const groupId = invites[inviteToken];
    if (!groupId) return null;
    return this.getGroup(groupId);
  }

  async getGroup(groupId) {
    const dir = this.groupDir(groupId);
    if (!(await exists(path.join(dir, "group.json")))) return null;
    return readJson(path.join(dir, "group.json"));
  }

  async listMembers(groupId) {
    return readJson(path.join(this.groupDir(groupId), "members.json"));
  }

  async authenticate(groupId, token) {
    if (!token) return null;
    return (await this.listMembers(groupId)).find((member) => member.token === token) ?? null;
  }

  async accounts() {
    return readJson(this.accountsFile);
  }

  async updateAccounts(update) {
    const next = this.accountQueue.then(async () => {
      const accounts = await this.accounts();
      const result = await update(accounts);
      await writeJsonAtomic(this.accountsFile, accounts);
      return result;
    });
    this.accountQueue = next.catch(() => {});
    return next;
  }

  async createAccount(email) {
    const normalizedEmail = email.trim().toLocaleLowerCase("en-US");
    return this.updateAccounts((accounts) => {
      if (Object.values(accounts).some((account) => account.normalizedEmail === normalizedEmail)) {
        return null;
      }
      const account = {
        id: id(),
        email: normalizedEmail,
        normalizedEmail,
        displayName: normalizedEmail.split("@")[0],
        avatarDataUrl: null,
        token: secret(),
        createdAt: new Date().toISOString(),
        memberships: []
      };
      accounts[account.id] = account;
      return account;
    });
  }

  async authenticateAccount(token) {
    if (!token) return null;
    return Object.values(await this.accounts())
      .find((account) => account.token === token) ?? null;
  }

  async updateAccountProfile(accountId, profile) {
    return this.updateAccounts((accounts) => {
      const account = accounts[accountId];
      if (!account) return null;
      account.displayName = profile.displayName;
      account.avatarDataUrl = profile.avatarDataUrl;
      account.updatedAt = new Date().toISOString();
      return account;
    });
  }

  async renameAccountMemberships(account, displayName) {
    const updated = [];
    for (const membership of account.memberships ?? []) {
      const members = await this.updateMembers(membership.groupId, (items) => {
        const changed = [];
        const human = items.find((member) => member.id === membership.memberId && member.type === "human");
        if (human && human.name !== displayName) {
          human.name = displayName;
          changed.push(human);
        }
        for (const member of items) {
          if (member.type === "ai" && member.desktopOwnerAccountId === account.id && member.ownerName !== displayName) {
            member.ownerName = displayName;
            changed.push(member);
          }
        }
        return changed;
      }).catch(() => []);
      updated.push(...members.map((member) => ({ groupId: membership.groupId, member })));
    }
    return updated;
  }

  async linkAccountMemberships(accountId, memberships) {
    return this.updateAccounts((accounts) => {
      const account = accounts[accountId];
      if (!account) return null;
      for (const membership of memberships) {
        const existing = account.memberships.find((item) => item.groupId === membership.groupId);
        if (existing) {
          existing.memberId = membership.memberId;
          existing.memberToken = membership.memberToken;
          existing.linkedAt = new Date().toISOString();
        } else {
          account.memberships.push({
            ...membership,
            linkedAt: new Date().toISOString()
          });
        }
      }
      return account;
    });
  }

  async unlinkAccountMembership(accountId, groupId) {
    return this.updateAccounts((accounts) => {
      const account = accounts[accountId];
      if (!account) return false;
      const before = account.memberships.length;
      account.memberships = account.memberships.filter((membership) => membership.groupId !== groupId);
      return account.memberships.length !== before;
    });
  }

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
        source: {
          text: sourceMessage.text,
          sender: sourceMessage.sender,
          attachments: sourceMessage.attachments ?? []
        },
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
            title: jira.title,
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
            progress: null,
            report: null,
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
          task.progress = message.text || task.progress;
        } else if (message.status === "failed") {
          task.status = "failed";
          task.startedAt ??= now;
          task.completedAt = now;
          task.report = message.text || task.report;
        } else {
          task.status = "completed";
          task.startedAt ??= now;
          task.completedAt = now;
          task.report = message.text || task.report;
        }
        changed.push(task);
      }
      return changed;
    });
  }

  async updateMembers(groupId, update) {
    const previous = this.memberQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const members = await this.listMembers(groupId);
      const result = await update(members);
      await writeJsonAtomic(path.join(this.groupDir(groupId), "members.json"), members);
      return result;
    });
    this.memberQueues.set(groupId, next.catch(() => {}));
    return next;
  }

  async setTrustedExecution(groupId, aiMemberId, ownerMemberId, enabled) {
    return this.updateMembers(groupId, (members) => {
      const member = members.find((candidate) => candidate.id === aiMemberId);
      if (!member || member.type !== "ai") return null;
      member.trustedOwnerMemberId = enabled ? ownerMemberId : null;
      return member;
    });
  }

  async addDesktopAI(
    groupId,
    { name, provider, ownerName, ownerMemberId, ownerAccountId, trustedOwnerMemberId = null }
  ) {
    return this.updateMembers(groupId, (members) => {
      const existing = members.find((member) => (
        member.type === "ai"
        && member.provider === provider
        && member.desktopOwnerAccountId === ownerAccountId
      ));
      if (existing) return { member: existing, created: false };
      const member = {
        id: id(),
        name,
        type: "ai",
        provider,
        ownerName,
        desktopOwnerAccountId: ownerAccountId,
        desktopOwnerMemberId: ownerMemberId,
        trustedOwnerMemberId,
        activeMessageIds: [],
        presence: {
          status: "online",
          lastSeenAt: new Date().toISOString()
        },
        token: secret(),
        joinedAt: new Date().toISOString()
      };
      members.push(member);
      return { member, created: true };
    });
  }

  async removeMember(groupId, memberId) {
    return this.updateMembers(groupId, (members) => {
      const index = members.findIndex((member) => member.id === memberId);
      if (index < 0) return false;
      members.splice(index, 1);
      return true;
    });
  }

  async updatePresence(groupId, memberId, status) {
    return this.updateMembers(groupId, (members) => {
      const member = members.find((candidate) => candidate.id === memberId);
      if (!member || member.type !== "ai") return null;
      member.presence = {
        status: status === "online" && member.activeMessageIds?.length ? "busy" : status,
        lastSeenAt: new Date().toISOString()
      };
      return member.presence;
    });
  }

  async setMessageActivity(groupId, memberId, messageId, processing) {
    return this.updateMembers(groupId, (members) => {
      const member = members.find((candidate) => candidate.id === memberId);
      if (!member || member.type !== "ai") return null;
      const active = new Set(member.activeMessageIds ?? []);
      if (processing) active.add(messageId);
      else active.delete(messageId);
      member.activeMessageIds = [...active];
      member.presence = {
        status: member.activeMessageIds.length ? "busy" : "online",
        lastSeenAt: new Date().toISOString()
      };
      return member.presence;
    });
  }

  async joinGroup(inviteToken, { name, type, provider, ownerName }) {
    const group = await this.groupFromInvite(inviteToken);
    if (!group) return null;
    const member = {
      id: id(),
      name,
      type,
      provider: type === "ai" ? provider : null,
      ownerName: type === "ai" ? ownerName : null,
      presence: type === "ai" ? {
        status: "online",
        lastSeenAt: new Date().toISOString()
      } : null,
      token: secret(),
      joinedAt: new Date().toISOString()
    };
    await this.updateMembers(group.id, (members) => members.push(member));
    return { group, member };
  }

  async rotateInvite(groupId) {
    const group = await this.getGroup(groupId);
    const invites = await readJson(this.invitesFile);
    delete invites[group.inviteToken];
    group.inviteToken = secret();
    invites[group.inviteToken] = groupId;
    await writeJsonAtomic(path.join(this.groupDir(groupId), "group.json"), group);
    await writeJsonAtomic(this.invitesFile, invites);
    return group.inviteToken;
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
