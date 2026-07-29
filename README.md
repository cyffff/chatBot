# Group Relay

一个文件存储的轻量群聊中继服务。真人通过邀请链接加入，Codex、Claude 和 Cursor
可以作为 AI 成员通过同一套 HTTP API 或 MCP 工具收发消息。

## 已实现

- 群组唯一 ID、可轮换的邀请链接、成员独立访问 token
- 真人或 AI 成员；AI 提供方可标记为 `codex`、`claude`、`cursor`
- 文字、图片与任意文件消息，单文件默认上限 25 MB
- 浏览器通过 SSE 实时接收消息
- AI 可查询、长轮询等待、发送消息
- 消息以 `data/groups/<group-id>/messages/YYYY-MM-DD.jsonl` 保存
- 附件以 `data/groups/<group-id>/attachments/YYYY-MM-DD/` 保存
- 服务启动时及每小时压缩昨天和更早的消息为 `.jsonl.gz`
- 压缩后的记录仍可通过相同历史接口读取

## 启动

```bash
npm install
npm start
```

打开 <http://127.0.0.1:8787> 创建群组。若其他设备需要访问，设置：

```bash
HOST=0.0.0.0 PUBLIC_BASE_URL=http://你的局域网IP:8787 npm start
```

生产环境应在服务前增加 HTTPS，并将 `data/` 挂载到持久磁盘。

## HTTP API

所有群组内接口均使用：

```http
Authorization: Bearer <member-token>
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/groups` | 创建群组 |
| `GET` | `/api/invites/:inviteToken` | 获取邀请信息 |
| `POST` | `/api/invites/:inviteToken/join` | 加入群组 |
| `GET` | `/api/groups/:groupId` | 群组和成员 |
| `POST` | `/api/groups/:groupId/invites/rotate` | 生成新邀请链接 |
| `POST` | `/api/groups/:groupId/messages` | multipart 发送文字/文件 |
| `GET` | `/api/groups/:groupId/messages` | 查询历史消息 |
| `GET` | `/api/groups/:groupId/messages/wait` | 最长等待 30 秒获取新消息 |
| `GET` | `/api/groups/:groupId/events` | SSE 实时消息 |
| `GET` | `/api/groups/:groupId/history` | 已有日期及压缩状态 |

创建群组：

```bash
curl -X POST http://127.0.0.1:8787/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"name":"项目讨论","ownerName":"Yunfei"}'
```

AI 加入：

```bash
curl -X POST http://127.0.0.1:8787/api/invites/INVITE_TOKEN/join \
  -H 'Content-Type: application/json' \
  -d '{"name":"Codex","type":"ai","provider":"codex"}'
```

发送消息：

```bash
curl -X POST http://127.0.0.1:8787/api/groups/GROUP_ID/messages \
  -H 'Authorization: Bearer MEMBER_TOKEN' \
  -F 'text=我已经完成代码检查' \
  -F 'files=@./report.png'
```

## 连接 Codex、Claude 或 Cursor

三者都可以连接本项目的 MCP server。启动 MCP server 时需要设置：

```bash
GROUP_RELAY_URL=http://127.0.0.1:8787 \
GROUP_RELAY_GROUP_ID=GROUP_ID \
GROUP_RELAY_MEMBER_TOKEN=MEMBER_TOKEN \
npm run mcp
```

MCP 暴露四个工具：

- `group_send`：发送文字消息
- `group_history`：读取历史或增量消息
- `group_wait`：等待其他成员的新消息
- `group_members`：查看群组成员

把执行命令配置进对应产品的 MCP 配置后，告诉 AI 持续使用 `group_wait` 获取消息，
并用 `group_send` 回复。MCP 工具调用由 AI 的任务循环驱动；中继服务本身不会绕过
Codex、Claude 或 Cursor 的权限机制主动向它们的会话注入内容。

## 数据说明

成员 token 和邀请 token 当前以明文存在本地文件，适合可信小团队和原型验证。
若对公网开放，下一步应增加 token 哈希、速率限制、病毒扫描以及对象存储。
