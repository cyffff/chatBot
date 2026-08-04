import crypto from "node:crypto";
import express from "express";
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
const messageUpdateSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  status: z.enum(["processing", "complete", "failed"]),
  expectedGroupId: z.string().uuid().optional()
});

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ownerName: z.string().trim().min(1).max(60)
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

const sessionImportSchema = z.object({
  sessions: z.array(z.object({
    groupId: z.string().uuid(),
    memberToken: z.string().min(1).max(200)
  })).min(1).max(200)
});

const browserTransferImportSchema = z.object({
  sessions: z.array(z.object({
    groupId: z.string().uuid(),
    memberToken: z.string().min(1).max(200)
  })).max(200)
});

const joinSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(["human", "ai"]).default("human"),
  provider: z.enum(["codex", "claude", "cursor"]).nullable().optional(),
  ownerName: z.string().trim().max(60).nullable().optional()
}).superRefine((value, ctx) => {
  if (value.type === "ai" && !value.provider) {
    ctx.addIssue({ code: "custom", path: ["provider"], message: "AI member requires a provider" });
  }
  if (value.type === "ai" && !value.ownerName) {
    ctx.addIssue({ code: "custom", path: ["ownerName"], message: "AI member requires an owner name" });
  }
});

export async function createApp(options = {}) {
  const dataDir = options.dataDir ?? process.env.GROUP_RELAY_DATA_DIR ?? "./data";
  const configuredPublicBaseUrl = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
  const presenceTimeoutMs = Number(options.presenceTimeoutMs ?? 90_000);
  const maxFileSize = Number(process.env.MAX_FILE_SIZE_MB ?? 25) * 1024 * 1024;
  const store = options.store ?? new FileStore(dataDir);
  await store.init();

  const app = express();
  app.set("trust proxy", 1);
  const subscribers = new Map();
  const waiters = new Map();
  const browserTransfers = new Map();
  const webLogins = new Map();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSize, files: 10 }
  });

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

  const tokenFrom = (req) => {
    const authorization = req.get("authorization");
    if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
    return req.get("x-member-token") || req.query.token;
  };

  const accountTokenFrom = (req) => {
    const authorization = req.get("authorization");
    if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
    return req.get("x-account-token");
  };

  async function requireMember(req, res, next) {
    try {
      const member = await store.authenticate(req.params.groupId, tokenFrom(req));
      if (!member) return res.status(401).json({ error: "invalid member token" });
      req.member = member;
      next();
    } catch (error) {
      next(error);
    }
  }

  async function requireAccount(req, res, next) {
    try {
      const account = await store.authenticateAccount(accountTokenFrom(req));
      if (!account) return res.status(401).json({ error: "invalid account token" });
      req.account = account;
      next();
    } catch (error) {
      next(error);
    }
  }

  function publicAccount(account) {
    return {
      id: account.id,
      email: account.email,
      displayName: account.displayName ?? null,
      avatarDataUrl: account.avatarDataUrl ?? null,
      createdAt: account.createdAt
    };
  }

  async function accountSessions(account) {
    const sessions = [];
    for (const membership of account.memberships ?? []) {
      const [group, member, members] = await Promise.all([
        store.getGroup(membership.groupId),
        store.authenticate(membership.groupId, membership.memberToken).catch(() => null),
        store.listMembers(membership.groupId).catch(() => [])
      ]);
      if (!group || !member || member.id !== membership.memberId) continue;
      sessions.push({
        group: {
          id: group.id,
          name: group.name,
          createdAt: group.createdAt
        },
        member: publicMember(member),
        desktopAis: members
          .filter((candidate) => candidate.type === "ai" && candidate.desktopOwnerAccountId === account.id)
          .map(publicMember),
        memberToken: membership.memberToken,
        linkedAt: membership.linkedAt
      });
    }
    return sessions;
  }

  async function accountTasks(account) {
    const tasks = [];
    for (const membership of account.memberships ?? []) {
      const [group, member, groupTasks] = await Promise.all([
        store.getGroup(membership.groupId),
        store.authenticate(membership.groupId, membership.memberToken).catch(() => null),
        store.listTasks(membership.groupId).catch(() => [])
      ]);
      if (!group || !member || member.id !== membership.memberId) continue;
      for (const task of groupTasks) {
        if (task.createdBy?.id !== membership.memberId) continue;
        tasks.push({
          ...task,
          group: { id: group.id, name: group.name }
        });
      }
    }
    tasks.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return tasks;
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
      return {
        ...message,
        executionScope: directlyTrusted || delegatedBySiblingAI ? "trusted" : "restricted"
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
      const account = await store.createAccount(email);
      if (!account) {
        return res.status(409).json({
          error: "email already registered; restore this account with its account backup"
        });
      }
      res.status(201).json({
        account: publicAccount(account),
        accountToken: account.token
      });
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
      const account = await store.updateAccountProfile(req.account.id, profile);
      if (!account) return res.status(404).json({ error: "account not found" });
      const updatedMembers = await store.renameAccountMemberships(account, profile.displayName);
      for (const { groupId, member } of updatedMembers) publish(groupId, "member_updated", publicMember(member));
      res.json({ account: publicAccount(account) });
    } catch (error) {
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
      for (const membership of req.account.memberships ?? []) {
        const [group, owner, members, history] = await Promise.all([
          store.getGroup(membership.groupId),
          store.authenticate(membership.groupId, membership.memberToken).catch(() => null),
          store.listMembers(membership.groupId).catch(() => []),
          store.readMessages(membership.groupId, { limit: 1 }).catch(() => [])
        ]);
        if (!group || !owner || owner.id !== membership.memberId || owner.type !== "human") continue;
        for (const member of members) {
          if (member.type !== "ai" || member.desktopOwnerAccountId !== req.account.id) continue;
          workers.push({
            workerId: `desktop-${member.provider}-${group.id}`,
            baseUrl: publicBaseUrl(req),
            groupId: group.id,
            memberId: member.id,
            memberToken: member.token,
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

  app.post("/api/account/sessions/import", requireAccount, async (req, res, next) => {
    try {
      const { sessions } = sessionImportSchema.parse(req.body);
      const accepted = [];
      const rejected = [];
      for (const session of sessions) {
        const member = await store.authenticate(session.groupId, session.memberToken).catch(() => null);
        if (!member) {
          rejected.push({ groupId: session.groupId, reason: "invalid group or member token" });
          continue;
        }
        accepted.push({
          groupId: session.groupId,
          memberId: member.id,
          memberToken: session.memberToken
        });
      }
      if (accepted.length) {
        req.account = await store.linkAccountMemberships(req.account.id, accepted);
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
      const removed = await store.unlinkAccountMembership(req.account.id, groupId);
      res.json({ removed });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/account/sessions/:groupId/ais", requireAccount, async (req, res, next) => {
    try {
      const groupId = z.string().uuid().parse(req.params.groupId);
      const { provider } = desktopAiSchema.parse(req.body);
      const membership = (req.account.memberships ?? []).find((item) => item.groupId === groupId);
      if (!membership) return res.status(404).json({ error: "group is not linked to this account" });
      const [group, owner] = await Promise.all([
        store.getGroup(groupId),
        store.authenticate(groupId, membership.memberToken).catch(() => null)
      ]);
      if (!group || !owner || owner.id !== membership.memberId || owner.type !== "human") {
        return res.status(403).json({ error: "a human membership is required to attach desktop AI" });
      }
      const names = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
      const result = await store.addDesktopAI(groupId, {
        name: names[provider],
        provider,
        ownerName: owner.name,
        ownerMemberId: owner.id,
        ownerAccountId: req.account.id,
        trustedOwnerMemberId: owner.id === group.ownerMemberId ? owner.id : null
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
          memberToken: result.member.token,
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
      const membership = (req.account.memberships ?? []).find((item) => item.groupId === groupId);
      if (!membership) return res.status(404).json({ error: "group is not linked to this account" });
      const owner = await store.authenticate(groupId, membership.memberToken).catch(() => null);
      if (!owner || owner.id !== membership.memberId || owner.type !== "human") {
        return res.status(403).json({ error: "a human membership is required to remove desktop AI" });
      }
      const members = await store.listMembers(groupId);
      const member = members.find((candidate) => (
        candidate.type === "ai"
        && candidate.provider === provider
        && candidate.desktopOwnerAccountId === req.account.id
      ));
      if (!member) return res.status(404).json({ error: "desktop AI is not in this group" });
      await store.removeMember(groupId, member.id);
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
      accountId: req.account.id,
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
      accountId: req.account.id,
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
      const account = (await store.accounts())[login.accountId];
      if (!account) return res.status(404).json({ error: "account not found" });
      login.status = "claimed";
      res.json({
        account: publicAccount(account),
        accountToken: account.token
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account/browser-transfers/:transferToken", requireAccount, (req, res) => {
    const transfer = activeBrowserTransfer(req.params.transferToken);
    if (!transfer || transfer.accountId !== req.account.id) {
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
      const account = (await store.accounts())[transfer.accountId];
      if (!account) return res.status(404).json({ error: "account not found" });
      const accepted = [];
      const rejected = [];
      for (const session of sessions) {
        const member = await store.authenticate(session.groupId, session.memberToken).catch(() => null);
        if (!member) {
          rejected.push({ groupId: session.groupId, reason: "invalid group or member token" });
          continue;
        }
        accepted.push({
          groupId: session.groupId,
          memberId: member.id,
          memberToken: session.memberToken
        });
      }
      if (accepted.length) await store.linkAccountMemberships(account.id, accepted);
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
      const result = await store.joinGroup(req.params.inviteToken, input);
      if (!result) return res.status(404).json({ error: "invite not found" });
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
          req.params.memberId,
          req.member.id,
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
      await store.removeMember(req.params.groupId, req.member.id);
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
      publish(req.params.groupId, "member_presence", {
        id: req.member.id,
        presence
      });
      res.json({ presence });
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

  return { app, store };
}
