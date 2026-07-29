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

export class FileStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.groupsDir = path.join(this.root, "groups");
    this.invitesFile = path.join(this.root, "invites.json");
    this.writeQueues = new Map();
  }

  async init() {
    await fs.mkdir(this.groupsDir, { recursive: true });
    if (!(await exists(this.invitesFile))) await writeJsonAtomic(this.invitesFile, {});
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
      inviteToken
    };
    const dir = this.groupDir(groupId);
    await fs.mkdir(path.join(dir, "messages"), { recursive: true });
    await fs.mkdir(path.join(dir, "attachments"), { recursive: true });
    await writeJsonAtomic(path.join(dir, "group.json"), group);
    await writeJsonAtomic(path.join(dir, "members.json"), [owner]);
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

  async joinGroup(inviteToken, { name, type, provider, ownerName }) {
    const group = await this.groupFromInvite(inviteToken);
    if (!group) return null;
    const member = {
      id: id(),
      name,
      type,
      provider: type === "ai" ? provider : null,
      ownerName: type === "ai" ? ownerName : null,
      token: secret(),
      joinedAt: new Date().toISOString()
    };
    const members = await this.listMembers(group.id);
    members.push(member);
    await writeJsonAtomic(path.join(this.groupDir(group.id), "members.json"), members);
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
        await fs.writeFile(path.join(dir, diskName), file.buffer);
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

  async appendMessage(groupId, member, { text, attachments, replyTo }) {
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
      replyTo: replyTo || null,
      createdAt
    };
    const file = path.join(this.groupDir(groupId), "messages", `${dayOf(createdAt)}.jsonl`);
    const previous = this.writeQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(() => fs.appendFile(file, `${JSON.stringify(message)}\n`, "utf8"));
    this.writeQueues.set(groupId, next.catch(() => {}));
    await next;
    return message;
  }

  async messageFiles(groupId) {
    const dir = path.join(this.groupDir(groupId), "messages");
    const names = await fs.readdir(dir);
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  }

  async readMessages(groupId, { after, limit = 100 } = {}) {
    const messages = [];
    for (const file of await this.messageFiles(groupId)) {
      const raw = await fs.readFile(file);
      const content = file.endsWith(".gz") ? (await gunzip(raw)).toString("utf8") : raw.toString("utf8");
      messages.push(...parseJsonl(content));
    }
    let start = 0;
    if (after) {
      const index = messages.findIndex((message) => message.id === after);
      if (index >= 0) start = index + 1;
    }
    return messages.slice(start).slice(-Math.min(Math.max(Number(limit) || 100, 1), 500));
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
}
