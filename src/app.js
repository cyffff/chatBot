import crypto from "node:crypto";
import express from "express";
import fs from "node:fs/promises";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FileStore } from "./storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");

const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);
const jiraUrlPattern = /https?:\/\/[^\s<>"']+\/browse\/[a-z][a-z0-9_]*-\d+[^\s<>"']*/gi;

function jiraReferences(text) {
  const references = [];
  const seen = new Set();
  for (const match of String(text ?? "").matchAll(jiraUrlPattern)) {
    const url = match[0].replace(/[),.;!?，。；！？]+$/u, "");
    const key = url.match(/\/browse\/([a-z][a-z0-9_]*-\d+)/i)?.[1]?.toUpperCase();
    if (!key || seen.has(url)) continue;
    seen.add(url);
    references.push({ key, url });
  }
  if (!references.length) return [];
  const title = cleanText(
    String(text ?? "").replace(jiraUrlPattern, " ").replace(/\s+/g, " "),
    180
  );
  return references.map((reference) => ({ ...reference, title: title || reference.key }));
}
const presenceSchema = z.object({
  status: z.enum(["online", "busy"]),
  recoverInterrupted: z.boolean().optional().default(false)
});
const trustedExecutionSchema = z.object({ enabled: z.boolean() });
const approvalRequestSchema = z.object({
  sourceMessageId: z.string().uuid(),
  summary: z.string().trim().min(1).max(500)
});
const approvalBatchSchema = z.object({
  approvalIds: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(["approve", "reject"])
});
const messageUpdateSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  status: z.enum(["processing", "complete", "failed"]),
  expectedGroupId: z.string().uuid().optional()
});

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  displayName: z.string().trim().min(1).max(60)
});

// 只允许 http/https,并且推过去的永远只有这个账号自己的数据。
const syncSchema = z.object({
  targetBaseUrl: z.string().trim().url().refine(
    (value) => /^https?:$/.test(new URL(value).protocol),
    { message: "server URL must be http or https" }
  )
});

const accountSchema = z.object({
  email: z.string().trim().email().max(254)
});

const accountProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  avatarDataUrl: z.string().max(750_000).nullable()
}).strict().superRefine((value, ctx) => {
  if (value.avatarDataUrl === null) return;
  const match = value.avatarDataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || Buffer.from(match[2], "base64").byteLength > 512 * 1024) {
    ctx.addIssue({ code: "custom", path: ["avatarDataUrl"], message: "avatar must be a PNG, JPEG or WebP image up to 512 KB" });
  }
});

const desktopAiSchema = z.object({
  provider: z.enum(["codex", "claude", "cursor"])
});

// 会话迁移只需要群 id:身份是 email,没有 token 可搬。
const sessionImportSchema = z.object({
  sessions: z.array(z.object({ groupId: z.string().uuid() })).min(1).max(200)
});

const browserTransferImportSchema = z.object({
  sessions: z.array(z.object({ groupId: z.string().uuid() })).max(200)
});

const joinSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(60),
  type: z.enum(["human", "ai"]).default("human"),
  provider: z.enum(["codex", "claude", "cursor"]).nullable().optional()
}).superRefine((value, ctx) => {
  if (value.type === "ai" && !value.provider) {
    ctx.addIssue({ code: "custom", path: ["provider"], message: "AI member requires a provider" });
  }
});

export async function createApp(options = {}) {
  const dataDir = options.dataDir ?? process.env.GROUP_RELAY_DATA_DIR ?? "./data";
  const configuredPublicBaseUrl = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
  const presenceTimeoutMs = Number(options.presenceTimeoutMs ?? 90_000);
  const expiredTokenGraceMs = Number(options.expiredTokenGraceMs ?? 10 * 60_000);
  const maxFileSize = Number(process.env.MAX_FILE_SIZE_MB ?? 25) * 1024 * 1024;
  const store = options.store ?? new FileStore(dataDir);
  await store.init();

  const app = express();
  app.set("trust proxy", 1);
  const subscribers = new Map();
  const waiters = new Map();
  const browserTransfers = new Map();
  const webLogins = new Map();
  // 落盘而不是 memoryStorage:后者一个请求最多把 fileSize × files = 250MB 缓进 RAM,
  // 1G 内存的机器一次上传就能被打死。临时文件和数据目录同盘,搬运走 rename。
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, done) => done(null, store.uploadTempDir),
      filename: (_req, _file, done) => done(null, crypto.randomUUID())
    }),
    limits: { fileSize: maxFileSize, files: 10 }
  });

  const discardUploads = async (req) => {
    await Promise.all((req.files ?? [])
      .filter((file) => file.path)
      .map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
  };

  const publicBaseUrl = (req) => (
    configuredPublicBaseUrl?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(publicDir, {
    etag: false,
    lastModified: false,
    setHeaders(response) {
      response.set("Cache-Control", "no-store");
    }
  }));

  // 身份就是 email:没有 token,也没有鉴权。带 provider 表示以该 email 名下的那个 AI
  // 身份行动,不带就是真人本人。SSE 和附件链接没法带自定义头,所以也接受 query。
  const identityFrom = (req) => {
    const email = req.get("x-relay-email") || req.query.email;
    if (email) {
      return { email, provider: req.get("x-relay-provider") || req.query.provider || null };
    }
    // 迁移宽限期:旧客户端还在发 token,用它换回 email,响应里带着 email 让它存下来。
    const authorization = req.get("authorization");
    const legacyToken = (authorization?.startsWith("Bearer ") ? authorization.slice(7) : null)
      || req.get("x-member-token")
      || req.get("x-account-token")
      || req.query.token;
    return {
      email: store.emailForLegacyToken(legacyToken),
      provider: req.get("x-relay-provider") || req.query.provider || null
    };
  };

  async function requireMember(req, res, next) {
    try {
      const { email, provider } = identityFrom(req);
      const member = await store.memberFor(req.params.groupId, email, provider);
      if (!member) return res.status(404).json({ error: "not a member of this group" });
      req.member = member;
      next();
    } catch (error) {
      next(error);
    }
  }

  async function requireAccount(req, res, next) {
    try {
      const account = await store.accountByEmail(identityFrom(req).email);
      if (!account) return res.status(404).json({ error: "unknown account" });
      req.account = account;
      next();
    } catch (error) {
      next(error);
    }
  }

  /// 账号的群组关系 = 它建的群 + 它加入的群。原来是 memberships 数组带 token,现在推导。
  async function accountMemberships(account) {
    const memberships = [];
    for (const groupId of store.groupIdsFor(account)) {
      const [group, member] = await Promise.all([
        store.getGroup(groupId).catch(() => null),
        store.memberFor(groupId, account.email).catch(() => null)
      ]);
      if (group && member) memberships.push({ groupId, group, member });
    }
    return memberships;
  }

  function publicAccount(account) {
    return {
      // email 就是账号 id,没有第二个标识符。
      id: account.email,
      email: account.email,
      displayName: account.displayName ?? null,
      avatarDataUrl: account.avatarDataUrl ?? null,
      createdAt: account.createdAt
    };
  }

  async function accountSessions(account) {
    const sessions = [];
    for (const { group, member } of await accountMemberships(account)) {
      const members = await store.listMembers(group.id).catch(() => []);
      sessions.push({
        group: {
          id: group.id,
          name: group.name,
          createdAt: group.createdAt
        },
        member: publicMember(member),
        desktopAis: members
          .filter((candidate) => candidate.type === "ai" && candidate.email === account.email)
          .map(publicMember),
        email: account.email,
        linkedAt: member.joinedAt
      });
    }
    return sessions;
  }

  async function accountTasks(account) {
    const tasks = [];
    for (const { group, member } of await accountMemberships(account)) {
      const groupTasks = await store.listTasks(group.id).catch(() => []);
      for (const task of groupTasks) {
        if (task.createdBy?.id !== member.id) continue;
        tasks.push({
          ...task,
          group: { id: group.id, name: group.name }
        });
      }
    }
    tasks.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return tasks;
  }

  async function accountApprovals(account) {
    const approvals = [];
    for (const { group, member } of await accountMemberships(account)) {
      const groupApprovals = await store.listApprovals(group.id).catch(() => []);
      for (const approval of groupApprovals) {
        if (approval.ownerMemberId !== member.id) continue;
        approvals.push({ ...approval, group: { id: group.id, name: group.name } });
      }
    }
    approvals.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return approvals;
  }

  function activeBrowserTransfer(token) {
    const transfer = browserTransfers.get(token);
    if (!transfer) return null;
    if (Date.now() > transfer.expiresAt) {
      transfer.status = "expired";
    }
    return transfer;
  }

  function activeWebLogin(token) {
    const login = webLogins.get(token);
    if (!login) return null;
    if (Date.now() > login.expiresAt) login.status = "expired";
    return login;
  }

  // 过期的一次性令牌原来只被标成 expired,条目永远留在 Map 里。保留一段宽限期让前端还能
  // 读到"已过期"的状态,过了宽限期才真正丢掉。
  const sweepExpiredTokens = (now = Date.now()) => {
    for (const map of [browserTransfers, webLogins]) {
      for (const [token, record] of map) {
        if (now > record.expiresAt + expiredTokenGraceMs) map.delete(token);
      }
    }
  };
  const tokenSweepTimer = setInterval(() => sweepExpiredTokens(), expiredTokenGraceMs);
  tokenSweepTimer.unref();

  async function sourceMessageFor(groupId, messageId) {
    if (!messageId) return null;
    const recent = await store.readMessages(groupId, { limit: 500 }).catch(() => []);
    return recent.find((message) => message.id === messageId) ?? null;
  }

  function publish(groupId, event, payload) {
    for (const response of subscribers.get(groupId) ?? []) {
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    const pending = waiters.get(groupId) ?? new Set();
    for (const waiter of [...pending]) {
      if (event === "message" || waiter.includeMemberEvents) {
        waiter.finish({ event, payload });
      }
    }
  }

  function routedMessages(messages, member, enabled, groupMembers = []) {
    if (!enabled || member.type !== "ai") return messages;
    const membersById = new Map(groupMembers.map((candidate) => [candidate.id, candidate]));
    return messages.filter((message) => {
      if (message.sender?.id === member.id) return false;
      if (message.mentions?.length) {
        return message.mentions.some((mention) => mention.id === member.id);
      }
      return message.sender?.type !== "ai";
    }).map((message) => {
      const sender = membersById.get(message.sender?.id);
      const directlyTrusted = Boolean(
        member.trustedOwnerMemberId
        && member.trustedOwnerMemberId === message.sender?.id
      );
      const delegatedBySiblingAI = Boolean(
        member.trustedOwnerMemberId
        && member.desktopOwnerAccountId
        && sender?.type === "ai"
        && sender.trustedOwnerMemberId === member.trustedOwnerMemberId
        && sender.desktopOwnerAccountId === member.desktopOwnerAccountId
      );
      const approvedOnce = message.approval?.targetMemberId === member.id;
      return {
        ...message,
        executionScope: directlyTrusted || delegatedBySiblingAI || approvedOnce ? "trusted" : "restricted"
      };
    });
  }

  function publicMember(member) {
    const {
      token: _token,
      activeMessageIds = [],
      trustedOwnerMemberId,
      desktopOwnerAccountId: _desktopOwnerAccountId,
      desktopOwnerMemberId: _desktopOwnerMemberId,
      ...safe
    } = member;
    if (member.type !== "ai") return safe;
    const lastSeen = Date.parse(member.presence?.lastSeenAt ?? "");
    const active = Number.isFinite(lastSeen) && Date.now() - lastSeen <= presenceTimeoutMs;
    return {
      ...safe,
      trustedExecutionEnabled: Boolean(trustedOwnerMemberId),
      presence: {
        status: active ? (activeMessageIds.length ? "busy" : member.presence.status) : "offline",
        lastSeenAt: member.presence?.lastSeenAt ?? null
      }
    };
  }

  async function reportActivity(req, status) {
    if (req.member.type !== "ai") return null;
    const presence = await store.updatePresence(req.params.groupId, req.member.id, status);
    if (presence) {
      publish(req.params.groupId, "member_presence", {
        id: req.member.id,
        presence
      });
    }
    return presence;
  }

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/accounts", async (req, res, next) => {
    try {
      const { email } = accountSchema.parse(req.body);
      // 幂等:email 就是身份,重复提交同一个 email 返回同一个账号,没有「已被注册」这回事。
      const account = await store.ensureAccount(email);
      if (!account) return res.status(400).json({ error: "email is required" });
      res.status(201).json({ account: publicAccount(account) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account", requireAccount, (req, res) => {
    res.json({ account: publicAccount(req.account) });
  });

  app.patch("/api/account", requireAccount, async (req, res, next) => {
    try {
      const profile = accountProfileSchema.parse(req.body);
      const account = await store.updateAccountProfile(req.account.email, profile);
      if (!account) return res.status(404).json({ error: "account not found" });
      // 名册是推导出来的,改一处昵称即可;这里只负责把变化广播给在线的人。
      for (const { groupId } of await store.renameAccount(account.email, profile.displayName)) {
        const human = await store.memberFor(groupId, account.email);
        if (human) publish(groupId, "member_updated", publicMember(human));
      }
      res.json({ account: publicAccount(account) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account/export", requireAccount, async (req, res, next) => {
    try {
      res.json(await store.exportAccount(req.account.email));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/account/import", async (req, res, next) => {
    try {
      res.json(await store.importAccount(req.body));
    } catch (error) {
      if (error instanceof SyntaxError || /export/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  /// 同步在服务端之间直接做,不走浏览器 —— 否则要给每台服务器配 CORS,而且换域名时
  /// 页面还在旧域名下,跨域 POST 一定被拦。
  app.post("/api/account/sync", requireAccount, async (req, res, next) => {
    try {
      const { targetBaseUrl } = syncSchema.parse(req.body);
      const target = new URL("/api/account/import", targetBaseUrl);
      const payload = await store.exportAccount(req.account.email);
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000)
      }).catch((error) => {
        throw new Error(`目标服务器无法访问：${error.message}`);
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(502).json({
          error: body.error || `目标服务器返回 ${response.status}`,
          targetBaseUrl
        });
      }
      res.json({
        targetBaseUrl,
        synced: {
          email: payload.account.email,
          createdGroups: payload.createdGroups.length,
          joinedGroups: payload.joinedGroups.length,
          ais: payload.ais.length
        },
        applied: body
      });
    } catch (error) {
      if (error?.message?.startsWith("目标服务器")) {
        return res.status(502).json({ error: error.message });
      }
      next(error);
    }
  });

  app.get("/api/account/sessions", requireAccount, async (req, res, next) => {
    try {
      res.json({ sessions: await accountSessions(req.account) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account/desktop-workers", requireAccount, async (req, res, next) => {
    try {
      const workers = [];
      for (const { group, member: owner } of await accountMemberships(req.account)) {
        const [members, history] = await Promise.all([
          store.listMembers(group.id).catch(() => []),
          store.readMessages(group.id, { limit: 1 }).catch(() => [])
        ]);
        if (owner.type !== "human") continue;
        for (const member of members) {
          if (member.type !== "ai" || member.email !== req.account.email) continue;
          workers.push({
            workerId: `desktop-${member.provider}-${group.id}`,
            baseUrl: publicBaseUrl(req),
            groupId: group.id,
            memberId: member.id,
            email: member.email,
            memberName: member.name,
            provider: member.provider,
            ownerName: owner.name,
            sessionId: `desktop-${member.provider}-${group.id}`,
            cursor: history.at(-1)?.id ?? null
          });
        }
      }
      res.json({ workers });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account/tasks", requireAccount, async (req, res, next) => {
    try {
      const tasks = await accountTasks(req.account);
      const summary = { assigned: 0, in_progress: 0, completed: 0, failed: 0 };
      for (const task of tasks) summary[task.status] = (summary[task.status] ?? 0) + 1;
      res.json({ tasks, summary });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account/approvals", requireAccount, async (req, res, next) => {
    try {
      const approvals = await accountApprovals(req.account);
      res.json({
        approvals,
        pendingCount: approvals.filter((approval) => approval.status === "pending").length
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/account/approvals/resolve", requireAccount, async (req, res, next) => {
    try {
      const { approvalIds, action } = approvalBatchSchema.parse(req.body);
      const requested = new Set(approvalIds);
      const results = [];
      for (const { group, member: owner } of await accountMemberships(req.account)) {
        if (!requested.size) break;
        const [approvals, members] = await Promise.all([
          store.listApprovals(group.id).catch(() => []),
          store.listMembers(group.id).catch(() => [])
        ]);
        for (const approval of approvals) {
          if (!requested.has(approval.id) || approval.ownerMemberId !== owner.id) continue;
          requested.delete(approval.id);
          if (approval.status !== "pending") {
            results.push({ id: approval.id, status: approval.status, unchanged: true });
            continue;
          }
          const resolution = await store.resolveApproval(
            group.id,
            approval.id,
            owner.id,
            action === "approve" ? "approved" : "rejected"
          );
          if (!resolution?.approval) continue;
          if (action === "approve") {
            const target = members.find((member) => member.id === approval.aiMember.id && member.type === "ai");
            if (target) {
              // 原文按 id 从缓冲区取,不再从审批单里的副本读。过了保留期取不到就退回
              // AI 自己写的 summary —— 派下去的活还能描述清楚,只是少了原始附件。
              const source = await sourceMessageFor(group.id, approval.sourceMessageId);
              const redelivery = await store.appendMessage(group.id, owner, {
                text: `【已批准执行】${source?.text || approval.summary}`,
                attachments: source?.attachments ?? [],
                mentions: [{
                  id: target.id,
                  name: target.name,
                  provider: target.provider,
                  ownerName: target.ownerName ?? null
                }],
                replyTo: approval.sourceMessageId,
                approval: { id: approval.id, targetMemberId: target.id }
              });
              publish(group.id, "message", redelivery);
            }
          }
          publish(group.id, "approval_updated", resolution.approval);
          results.push({ id: approval.id, status: resolution.approval.status });
        }
      }
      if (requested.size) {
        return res.status(404).json({ error: "one or more approval requests were not found" });
      }
      res.json({ results, approvals: await accountApprovals(req.account) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/account/sessions/import", requireAccount, async (req, res, next) => {
    try {
      const { sessions } = sessionImportSchema.parse(req.body);
      const accepted = [];
      const rejected = [];
      for (const session of sessions) {
        const group = await store.getGroup(session.groupId).catch(() => null);
        if (!group) {
          rejected.push({ groupId: session.groupId, reason: "unknown group" });
          continue;
        }
        accepted.push({ groupId: session.groupId });
      }
      if (accepted.length) {
        req.account = await store.linkGroups(req.account.email, accepted.map((item) => item.groupId));
      }
      res.json({
        imported: accepted.length,
        rejected,
        sessions: await accountSessions(req.account)
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/account/sessions/:groupId", requireAccount, async (req, res, next) => {
    try {
      const groupId = z.string().uuid().parse(req.params.groupId);
      const removed = await store.leaveGroup(groupId, req.account.email);
      res.json({ removed });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/account/sessions/:groupId/ais", requireAccount, async (req, res, next) => {
    try {
      const groupId = z.string().uuid().parse(req.params.groupId);
      const { provider } = desktopAiSchema.parse(req.body);
      const group = await store.getGroup(groupId).catch(() => null);
      const owner = await store.memberFor(groupId, req.account.email);
      if (!group || !owner || owner.type !== "human") {
        return res.status(403).json({ error: "a human membership is required to attach desktop AI" });
      }
      const names = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
      const result = await store.addDesktopAI(groupId, {
        name: names[provider],
        provider,
        email: req.account.email,
        trusted: owner.id === group.ownerMemberId
      });
      const history = await store.readMessages(groupId, { limit: 1 });
      if (result.created) publish(groupId, "member_joined", publicMember(result.member));
      res.status(result.created ? 201 : 200).json({
        member: publicMember(result.member),
        worker: {
          workerId: `desktop-${provider}-${groupId}`,
          baseUrl: publicBaseUrl(req),
          groupId,
          memberId: result.member.id,
          email: result.member.email,
          memberName: result.member.name,
          provider,
          ownerName: owner.name,
          sessionId: `desktop-${provider}-${groupId}`,
          cursor: history.at(-1)?.id ?? null
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/account/sessions/:groupId/ais/:provider", requireAccount, async (req, res, next) => {
    try {
      const groupId = z.string().uuid().parse(req.params.groupId);
      const { provider } = desktopAiSchema.parse({ provider: req.params.provider });
      const owner = await store.memberFor(groupId, req.account.email);
      if (!owner || owner.type !== "human") {
        return res.status(403).json({ error: "a human membership is required to remove desktop AI" });
      }
      const member = await store.memberFor(groupId, req.account.email, provider);
      if (!member) return res.status(404).json({ error: "desktop AI is not in this group" });
      await store.removeDesktopAI(groupId, req.account.email, provider);
      publish(groupId, "member_left", { id: member.id });
      res.json({
        disconnected: true,
        memberId: member.id,
        workerId: `desktop-${provider}-${groupId}`
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/account/browser-transfers", requireAccount, (req, res) => {
    const transferToken = crypto.randomBytes(24).toString("base64url");
    const transfer = {
      token: transferToken,
      email: req.account.email,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 5 * 60_000,
      imported: 0,
      rejected: []
    };
    browserTransfers.set(transferToken, transfer);
    res.status(201).json({
      transferToken,
      transferUrl: `${publicBaseUrl(req)}/transfer/${transferToken}`,
      expiresAt: new Date(transfer.expiresAt).toISOString()
    });
  });

  app.post("/api/account/web-logins", requireAccount, (req, res) => {
    const loginToken = crypto.randomBytes(24).toString("base64url");
    const login = {
      token: loginToken,
      email: req.account.email,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 5 * 60_000
    };
    webLogins.set(loginToken, login);
    res.status(201).json({
      loginToken,
      loginUrl: `${publicBaseUrl(req)}/web-login/${loginToken}`,
      expiresAt: new Date(login.expiresAt).toISOString()
    });
  });

  app.post("/api/web-logins/:loginToken/claim", async (req, res, next) => {
    try {
      const login = activeWebLogin(req.params.loginToken);
      if (!login) return res.status(404).json({ error: "web login not found" });
      if (login.status === "expired") return res.status(410).json({ error: "web login expired" });
      if (login.status !== "pending") return res.status(409).json({ error: "web login already used" });
      const account = await store.accountByEmail(login.email);
      if (!account) return res.status(404).json({ error: "account not found" });
      login.status = "claimed";
      res.json({
        account: publicAccount(account),
        email: account.email
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account/browser-transfers/:transferToken", requireAccount, (req, res) => {
    const transfer = activeBrowserTransfer(req.params.transferToken);
    if (!transfer || transfer.email !== req.account.email) {
      return res.status(404).json({ error: "browser transfer not found" });
    }
    res.json({
      status: transfer.status,
      imported: transfer.imported,
      rejected: transfer.rejected,
      expiresAt: new Date(transfer.expiresAt).toISOString()
    });
  });

  app.post("/api/browser-transfers/:transferToken/import", async (req, res, next) => {
    try {
      const transfer = activeBrowserTransfer(req.params.transferToken);
      if (!transfer) return res.status(404).json({ error: "browser transfer not found" });
      if (transfer.status === "expired") return res.status(410).json({ error: "browser transfer expired" });
      if (transfer.status !== "pending") return res.status(409).json({ error: "browser transfer already used" });
      const { sessions } = browserTransferImportSchema.parse(req.body);
      const account = await store.accountByEmail(transfer.email);
      if (!account) return res.status(404).json({ error: "account not found" });
      const accepted = [];
      const rejected = [];
      for (const session of sessions) {
        const group = await store.getGroup(session.groupId).catch(() => null);
        if (!group) {
          rejected.push({ groupId: session.groupId, reason: "unknown group" });
          continue;
        }
        accepted.push({ groupId: session.groupId });
      }
      if (accepted.length) {
        await store.linkGroups(account.email, accepted.map((item) => item.groupId));
      }
      transfer.status = accepted.length ? "completed" : "failed";
      transfer.imported = accepted.length;
      transfer.rejected = rejected;
      res.json({
        status: transfer.status,
        imported: transfer.imported,
        rejected
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/groups", async (req, res, next) => {
    try {
      const input = createGroupSchema.parse(req.body);
      const result = await store.createGroup(input);
      res.status(201).json({
        group: result.group,
        member: result.owner,
        inviteUrl: `${publicBaseUrl(req)}/join/${result.group.inviteToken}`
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/invites/:inviteToken", async (req, res, next) => {
    try {
      const group = await store.groupFromInvite(req.params.inviteToken);
      if (!group) return res.status(404).json({ error: "invite not found" });
      res.json({ group: { id: group.id, name: group.name } });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/invites/:inviteToken/join", async (req, res, next) => {
    try {
      const input = joinSchema.parse(req.body);
      const result = await store.joinGroup(req.params.inviteToken, {
        email: input.email,
        // AI 用的是主人的 email,它自己的名字记在 AI 注册项上,不能覆盖主人的昵称。
        displayName: input.type === "ai" ? null : input.name
      });
      if (!result) return res.status(404).json({ error: "invite not found" });
      // AI 通过邀请链接接入时,先把它挂到这个 email 名下,再作为该群的桌面 AI 注册。
      if (input.type === "ai") {
        const names = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
        const attached = await store.addDesktopAI(result.group.id, {
          name: input.name || names[input.provider],
          provider: input.provider,
          email: input.email,
          trusted: result.member.id === result.group.ownerMemberId
        });
        if (attached?.member) result.member = attached.member;
      }
      publish(result.group.id, "member_joined", {
        id: result.member.id,
        name: result.member.name,
        type: result.member.type,
        provider: result.member.provider,
        ownerName: result.member.ownerName
      });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/groups/:groupId", requireMember, async (req, res, next) => {
    try {
      const group = await store.getGroup(req.params.groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      const rawMembers = await store.listMembers(group.id);
      const ownerMemberId = group.ownerMemberId ?? rawMembers.find((member) => member.type === "human")?.id;
      const members = rawMembers.map((member) => ({
        ...publicMember(member),
        canManageTrustedExecution: member.type === "ai" && (
          member.desktopOwnerMemberId
            ? member.desktopOwnerMemberId === req.member.id
            : req.member.id === ownerMemberId
        )
      }));
      res.json({
        group,
        members,
        currentMemberId: req.member.id,
        canManageTrustedExecution: req.member.id === ownerMemberId
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/groups/:groupId/members/:memberId/trusted-execution",
    requireMember,
    async (req, res, next) => {
      try {
        const input = trustedExecutionSchema.parse(req.body);
        const [group, members] = await Promise.all([
          store.getGroup(req.params.groupId),
          store.listMembers(req.params.groupId)
        ]);
        if (!group) return res.status(404).json({ error: "group not found" });
        const ownerMemberId = group.ownerMemberId ?? members.find((member) => member.type === "human")?.id;
        const target = members.find((member) => member.id === req.params.memberId && member.type === "ai");
        if (!target) return res.status(404).json({ error: "AI member not found" });
        const canManage = target.desktopOwnerMemberId
          ? target.desktopOwnerMemberId === req.member.id
          : req.member.id === ownerMemberId;
        if (!canManage) {
          return res.status(403).json({ error: "only the AI owner can enable trusted execution" });
        }
        const member = await store.setTrustedExecution(
          req.params.groupId,
          target.email,
          target.provider,
          input.enabled
        );
        if (!member) return res.status(404).json({ error: "AI member not found" });
        publish(req.params.groupId, "member_updated", publicMember(member));
        res.json({ member: { ...publicMember(member), canManageTrustedExecution: true } });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete("/api/groups/:groupId/members/me", requireMember, async (req, res, next) => {
    try {
      if (req.member.type !== "ai") {
        return res.status(403).json({ error: "only AI members can disconnect themselves" });
      }
      await store.removeDesktopAI(req.params.groupId, req.member.email, req.member.provider);
      publish(req.params.groupId, "member_left", { id: req.member.id });
      res.json({ disconnected: true, memberId: req.member.id });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/groups/:groupId/members/me/presence", requireMember, async (req, res, next) => {
    try {
      if (req.member.type !== "ai") {
        return res.status(403).json({ error: "only AI members report presence" });
      }
      const { status, recoverInterrupted } = presenceSchema.parse(req.body);
      if (status === "online" && recoverInterrupted) {
        const interrupted = await store.failProcessingMessages(
          req.params.groupId,
          req.member.id,
          "任务因客户端重启或连接中断而停止，请重新发送任务。"
        );
        for (const message of interrupted) {
          await store.setMessageActivity(req.params.groupId, req.member.id, message.id, false);
          await store.updateAssignmentTasks(req.params.groupId, message);
          publish(req.params.groupId, "message_updated", message);
        }
      }
      const presence = await store.updatePresence(req.params.groupId, req.member.id, status);
      if (!presence) return res.status(404).json({ error: "member not found" });
      // 回带 email:走宽限期进来的旧客户端靠这个把自己的配置换成新身份。
      res.set("X-Relay-Resolved-Email", req.member.email);
      publish(req.params.groupId, "member_presence", {
        id: req.member.id,
        presence
      });
      res.json({ presence, email: req.member.email });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/groups/:groupId/approvals", requireMember, async (req, res, next) => {
    try {
      if (req.member.type !== "ai" || !req.member.desktopOwnerMemberId) {
        return res.status(403).json({ error: "only a desktop AI can request approval" });
      }
      const input = approvalRequestSchema.parse(req.body);
      const messages = await store.readMessages(req.params.groupId, { limit: 500 });
      const sourceMessage = messages.find((message) => message.id === input.sourceMessageId);
      if (!sourceMessage) return res.status(404).json({ error: "source message not found" });
      const result = await store.createApproval(req.params.groupId, {
        aiMember: req.member,
        ownerMemberId: req.member.desktopOwnerMemberId,
        sourceMessage,
        summary: input.summary
      });
      publish(req.params.groupId, "approval_requested", result.approval);
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/groups/:groupId/invites/rotate", requireMember, async (req, res, next) => {
    try {
      const inviteToken = await store.rotateInvite(req.params.groupId);
      res.json({ inviteUrl: `${publicBaseUrl(req)}/join/${inviteToken}` });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/groups/:groupId/messages", requireMember, async (req, res, next) => {
    try {
      await reportActivity(req, "online");
      const messages = await store.readMessages(req.params.groupId, {
        after: req.query.after,
        limit: req.query.limit
      });
      const isRouted = req.query.routed === "1";
      const groupMembers = isRouted ? await store.listMembers(req.params.groupId) : [];
      const routed = routedMessages(messages, req.member, isRouted, groupMembers);
      if (isRouted && routed.length) await reportActivity(req, "busy");
      res.json({
        messages: routed,
        cursor: messages.at(-1)?.id ?? req.query.after ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/groups/:groupId/messages/wait", requireMember, async (req, res, next) => {
    try {
      await reportActivity(req, "online");
      const existing = await store.readMessages(req.params.groupId, {
        after: req.query.after,
        limit: req.query.limit ?? 100
      });
      if (existing.length) {
        const isRouted = req.query.routed === "1";
        const groupMembers = isRouted ? await store.listMembers(req.params.groupId) : [];
        const routed = routedMessages(existing, req.member, isRouted, groupMembers);
        if (routed.length) await reportActivity(req, "busy");
        return res.json({
          messages: routed,
          cursor: existing.at(-1).id
        });
      }
      const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs) || 25_000, 1_000), 30_000);
      const update = await new Promise((resolve) => {
        const groupId = req.params.groupId;
        const groupWaiters = waiters.get(groupId) ?? new Set();
        let waiter;
        const finish = (value) => {
          clearTimeout(timeout);
          groupWaiters.delete(waiter);
          if (!groupWaiters.size && waiters.get(groupId) === groupWaiters) {
            waiters.delete(groupId);
          }
          resolve(value);
        };
        const timeout = setTimeout(() => finish(null), timeoutMs);
        waiter = {
          finish,
          includeMemberEvents: req.query.routed !== "1"
        };
        groupWaiters.add(waiter);
        waiters.set(groupId, groupWaiters);
      });
      const messages = update?.event === "message" ? [update.payload] : [];
      const isRouted = req.query.routed === "1";
      const groupMembers = isRouted ? await store.listMembers(req.params.groupId) : [];
      const routed = routedMessages(messages, req.member, isRouted, groupMembers);
      if (routed.length) await reportActivity(req, "busy");
      res.json({
        messages: routed,
        cursor: update?.event === "message" ? update.payload.id : req.query.after ?? null,
        event: update?.event ?? null,
        eventPayload: update?.event === "message" ? null : update?.payload ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/groups/:groupId/messages", requireMember, upload.array("files", 10), async (req, res, next) => {
    try {
      const text = cleanText(req.body.text, 20_000);
      const status = req.member.type === "ai" && ["processing", "complete", "failed"].includes(req.body.status)
        ? req.body.status
        : "complete";
      const attachments = await store.saveAttachments(req.params.groupId, req.files ?? []);
      if (!text && attachments.length === 0) {
        return res.status(400).json({ error: "text or file is required" });
      }
      let mentionIds = [];
      try {
        mentionIds = JSON.parse(req.body.mentions || "[]");
      } catch {
        return res.status(400).json({ error: "mentions must be a JSON array" });
      }
      if (!Array.isArray(mentionIds) || mentionIds.length > 20 || mentionIds.some((id) => typeof id !== "string")) {
        return res.status(400).json({ error: "invalid mentions" });
      }
      const members = await store.listMembers(req.params.groupId);
      const uniqueMentionIds = [...new Set(mentionIds)];
      const mentions = uniqueMentionIds.map((id) => members.find((member) => member.id === id));
      if (mentions.some((member) => !member)) {
        return res.status(400).json({ error: "mentioned member must be in this group" });
      }
      const message = await store.appendMessage(req.params.groupId, req.member, {
        text,
        attachments,
        mentions: mentions.map((member) => ({
          id: member.id,
          name: member.name,
          provider: member.provider,
          ownerName: member.ownerName ?? null
        })),
        replyTo: cleanText(req.body.replyTo, 100) || null,
        status
      });
      if (req.member.type === "ai") {
        await store.setMessageActivity(
          req.params.groupId,
          req.member.id,
          message.id,
          status === "processing"
        );
        await store.updateAssignmentTasks(req.params.groupId, message);
      } else {
        const references = jiraReferences(text);
        const mentionedAIs = mentions.filter((member) => member.type === "ai");
        if (references.length && mentionedAIs.length) {
          await store.createAssignmentTasks(req.params.groupId, message, mentionedAIs, references);
        }
      }
      publish(req.params.groupId, "message", message);
      await reportActivity(req, status === "processing" ? "busy" : "online");
      res.status(201).json({ message });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/groups/:groupId/messages/:messageId", requireMember, async (req, res, next) => {
    try {
      if (req.member.type !== "ai") {
        return res.status(403).json({ error: "only AI members can update their messages" });
      }
      const input = messageUpdateSchema.parse(req.body);
      if (input.expectedGroupId && input.expectedGroupId !== req.params.groupId) {
        return res.status(409).json({ error: "expected group does not match request group" });
      }
      const result = await store.updateMessage(
        req.params.groupId,
        req.params.messageId,
        req.member.id,
        input
      );
      if (!result) return res.status(404).json({ error: "message not found" });
      if (result.forbidden) return res.status(403).json({ error: "message belongs to another member" });
      await store.setMessageActivity(
        req.params.groupId,
        req.member.id,
        result.message.id,
        input.status === "processing"
      );
      await store.updateAssignmentTasks(req.params.groupId, result.message);
      publish(req.params.groupId, "message_updated", result.message);
      await reportActivity(req, input.status === "processing" ? "busy" : "online");
      res.json({ message: result.message });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/groups/:groupId/events", requireMember, (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    res.flushHeaders();
    res.write("event: ready\ndata: {}\n\n");
    const groupSubscribers = subscribers.get(req.params.groupId) ?? new Set();
    groupSubscribers.add(res);
    subscribers.set(req.params.groupId, groupSubscribers);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      groupSubscribers.delete(res);
      if (!groupSubscribers.size) subscribers.delete(req.params.groupId);
    });
  });

  app.get("/api/groups/:groupId/history", requireMember, async (req, res, next) => {
    try {
      res.json({ days: await store.history(req.params.groupId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/groups/:groupId/attachments/:day/:diskName", requireMember, async (req, res, next) => {
    try {
      const file = store.attachmentPath(req.params.groupId, req.params.day, req.params.diskName);
      res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(req.params.diskName.slice(37))}`);
      res.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  app.get("/join/:inviteToken", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/group/:groupId", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/app", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/transfer/:transferToken", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/web-login/:loginToken", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

  app.use(async (error, req, res, next) => {
    // 请求失败时把已落盘的上传删掉,不然要等清理任务兜。
    await discardUploads(req);
    next(error);
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "invalid input", details: error.issues });
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    if (error?.code === "ENOENT") return res.status(404).json({ error: "not found" });
    console.error(error);
    res.status(500).json({ error: "internal server error" });
  });

  return { app, store, sweepExpiredTokens };
}
