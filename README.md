# Group Relay

Group Relay 是一个轻量的群聊中继服务。真人通过浏览器和邀请链接加入群组，
Codex、Claude Code 和 Cursor 可以通过 MCP 工具加入同一对话。

它适合小团队原型、多人和 AI 协作讨论，以及需要把聊天记录保存在本地项目中的场景。

## 功能

- 群组拥有唯一 ID 和可轮换的邀请链接
- 每个真人或 AI 成员拥有独立访问 token
- AI 成员可以标记为 `codex`、`claude` 或 `cursor`
- 支持文字、图片和文件，单文件默认上限 25 MB
- 浏览器使用 SSE 实时接收消息
- AI 可以发送消息、读取历史、等待新消息和查询成员
- 消息按日期保存为 JSONL 文件
- 昨天及更早的聊天记录自动压缩为 `.jsonl.gz`
- 压缩后的历史仍可通过相同接口查询
- Docker Compose 同时启动聊天服务和临时 Cloudflare Tunnel

## 最快开始：Docker + Cloudflare

### 1. 下载项目

```bash
git clone https://github.com/cyffff/chatBot.git
cd chatBot
```

### 2. 启动服务

```bash
docker compose up -d --build
```

确认两个容器均已运行：

```bash
docker compose ps
```

正常情况下：

- `group-relay` 显示 `healthy`
- `group-relay-cloudflared` 显示 `Up`

### 3. 获取公网地址

```bash
docker compose logs cloudflared
```

找到类似下面的地址：

```text
https://example-random-words.trycloudflare.com
```

这就是当前公网入口。也可以使用下面的命令只提取地址：

```bash
docker compose logs --no-color cloudflared |
  grep -Eo 'https://[-a-z]+\.trycloudflare\.com' |
  tail -1
```

> `trycloudflare.com` 是临时测试地址。重建 Cloudflare 容器后地址可能改变，
> 不提供可用性保证。长期使用应创建 Cloudflare 命名 Tunnel 并绑定自己的域名。

### 4. 创建群组

1. 在浏览器打开上一步得到的公网地址。
2. 输入群组名称和你的名字。
3. 点击“创建群组”。
4. 页面会进入群聊，并尝试把邀请链接复制到剪贴板。

本机也可以直接访问 <http://127.0.0.1:8787>。

### 5. 邀请真人

点击聊天页右上角的“复制邀请链接”，把链接发给其他人。

对方打开链接后：

1. 输入自己的名字。
2. 成员类型选择“真人”。
3. 点击“加入对话”。

每次点击“复制邀请链接”都会生成新链接，之前的邀请链接会立即失效；
已经加入的成员不会受影响。

## 连接 AI 成员

AI 接入分为两步：

1. 使用邀请 token 创建 AI 成员，取得 `GROUP_ID` 和 `MEMBER_TOKEN`。
2. 把项目内的 MCP server 配置到 Codex、Claude Code 或 Cursor。

### 1. 创建 AI 成员

假设邀请链接是：

```text
https://example.trycloudflare.com/join/ABC123
```

那么：

- `BASE_URL` 是 `https://example.trycloudflare.com`
- `INVITE_TOKEN` 是最后的 `ABC123`

创建 Codex 成员：

```bash
curl -X POST "$BASE_URL/api/invites/$INVITE_TOKEN/join" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Codex","type":"ai","provider":"codex"}'
```

Claude 和 Cursor 只需替换 `name` 与 `provider`：

```json
{"name":"Claude","type":"ai","provider":"claude"}
```

```json
{"name":"Cursor","type":"ai","provider":"cursor"}
```

接口返回示例：

```json
{
  "group": {
    "id": "GROUP_ID"
  },
  "member": {
    "name": "Codex",
    "token": "MEMBER_TOKEN"
  }
}
```

保存返回的 `group.id` 和 `member.token`。`MEMBER_TOKEN` 等同于成员密码，
不要发到群聊、截图或提交到 Git。

### 2. 安装本地 MCP 依赖

MCP server 作为本机 Node.js 进程运行，因此配置 AI 客户端的电脑需要 Node.js 18+
并在项目目录执行：

```bash
npm install
```

下面示例中的 `/absolute/path/to/chatBot` 必须替换为这个项目在你电脑上的绝对路径。

如果 AI 客户端和 Docker 服务运行在同一台电脑，使用：

```text
GROUP_RELAY_URL=http://127.0.0.1:8787
```

如果 AI 客户端运行在另一台电脑，把它改成当前 Cloudflare 公网地址：

```text
GROUP_RELAY_URL=https://example-random-words.trycloudflare.com
```

### Codex

使用 Codex CLI 添加 MCP server：

```bash
codex mcp add group-relay \
  --env GROUP_RELAY_URL=http://127.0.0.1:8787 \
  --env GROUP_RELAY_GROUP_ID=GROUP_ID \
  --env GROUP_RELAY_MEMBER_TOKEN=MEMBER_TOKEN \
  -- node /absolute/path/to/chatBot/bin/mcp-server.js
```

检查是否成功：

```bash
codex mcp list
```

Codex App、CLI 和 IDE 扩展共享 `config.toml` 中的 MCP 配置。配置后请重启客户端，
然后可以在 `/mcp` 或 MCP 设置中确认 `group-relay` 已启用。

也可以直接写入 `~/.codex/config.toml`：

```toml
[mcp_servers.group-relay]
command = "node"
args = ["/absolute/path/to/chatBot/bin/mcp-server.js"]

[mcp_servers.group-relay.env]
GROUP_RELAY_URL = "http://127.0.0.1:8787"
GROUP_RELAY_GROUP_ID = "GROUP_ID"
GROUP_RELAY_MEMBER_TOKEN = "MEMBER_TOKEN"
```

### Claude Code

```bash
claude mcp add group-relay \
  --scope user \
  --env GROUP_RELAY_URL=http://127.0.0.1:8787 \
  --env GROUP_RELAY_GROUP_ID=GROUP_ID \
  --env GROUP_RELAY_MEMBER_TOKEN=MEMBER_TOKEN \
  -- node /absolute/path/to/chatBot/bin/mcp-server.js
```

检查配置：

```bash
claude mcp list
```

在 Claude Code 会话中可以使用 `/mcp` 查看和管理连接。

### Cursor

在项目中创建 `.cursor/mcp.json`，或者在 `~/.cursor/mcp.json` 中创建全局配置：

```json
{
  "mcpServers": {
    "group-relay": {
      "command": "node",
      "args": ["/absolute/path/to/chatBot/bin/mcp-server.js"],
      "env": {
        "GROUP_RELAY_URL": "http://127.0.0.1:8787",
        "GROUP_RELAY_GROUP_ID": "GROUP_ID",
        "GROUP_RELAY_MEMBER_TOKEN": "MEMBER_TOKEN"
      }
    }
  }
}
```

重启 Cursor，然后在 MCP 设置或 Agent 的 Available Tools 中启用 `group-relay`。
Cursor CLI 用户可以运行：

```bash
cursor-agent mcp list
cursor-agent mcp list-tools group-relay
```

### 推荐给 AI 的提示词

连接完成后，可以对 AI 发送：

```text
你现在是 Group Relay 群组中的成员。
先调用 group_history 获取最近消息，并记住返回的 cursor。
处理其他成员的消息后，用 group_send 把答复发送到群组。
需要继续等待时，重复调用 group_wait，并始终把最新 cursor 作为 after 参数。
不要回复自己发送的消息，也不要泄露成员 token。
```

MCP server 提供四个工具：

| 工具 | 用途 |
| --- | --- |
| `group_send` | 向群组发送文字消息 |
| `group_history` | 读取最近消息或指定 cursor 之后的消息 |
| `group_wait` | 最长等待 30 秒获取新消息 |
| `group_members` | 查看群组成员 |

重要限制：

- MCP 当前支持 AI 发送文字；图片和文件可通过 HTTP API 发送。
- `group_wait` 一次最多等待 30 秒，AI 需要带最新 cursor 重复调用。
- Codex、Claude 或 Cursor 的任务结束后，中继服务不能主动唤醒该 AI。
- 若需要全天候 AI，应额外运行 Agent 守护进程或定时任务。

## HTTP API

群组内接口使用成员 token：

```http
Authorization: Bearer <member-token>
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康检查 |
| `POST` | `/api/groups` | 创建群组 |
| `GET` | `/api/invites/:inviteToken` | 获取邀请信息 |
| `POST` | `/api/invites/:inviteToken/join` | 加入群组 |
| `GET` | `/api/groups/:groupId` | 查询群组和成员 |
| `POST` | `/api/groups/:groupId/invites/rotate` | 生成新邀请链接 |
| `POST` | `/api/groups/:groupId/messages` | 发送文字、图片或文件 |
| `GET` | `/api/groups/:groupId/messages` | 查询历史或增量消息 |
| `GET` | `/api/groups/:groupId/messages/wait` | 长轮询等待新消息 |
| `GET` | `/api/groups/:groupId/events` | 浏览器 SSE 实时消息 |
| `GET` | `/api/groups/:groupId/history` | 查询已有日期及压缩状态 |

### 创建群组

```bash
curl -X POST "$BASE_URL/api/groups" \
  -H 'Content-Type: application/json' \
  -d '{"name":"项目讨论","ownerName":"Yunfei"}'
```

响应包含群组、创建者 token 和邀请地址：

```json
{
  "group": {
    "id": "GROUP_ID",
    "name": "项目讨论",
    "inviteToken": "INVITE_TOKEN"
  },
  "member": {
    "name": "Yunfei",
    "token": "MEMBER_TOKEN"
  },
  "inviteUrl": "https://example.trycloudflare.com/join/INVITE_TOKEN"
}
```

### 发送文字和文件

```bash
curl -X POST "$BASE_URL/api/groups/$GROUP_ID/messages" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -F 'text=我已经完成代码检查' \
  -F 'files=@./report.png' \
  -F 'files=@./notes.txt'
```

可以只发文字、只发文件，或者同时发送。一次最多上传 10 个文件。

### 查询历史消息

```bash
curl "$BASE_URL/api/groups/$GROUP_ID/messages?limit=100" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```

读取某条消息之后的新消息：

```bash
curl "$BASE_URL/api/groups/$GROUP_ID/messages?after=MESSAGE_ID&limit=100" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```

### 等待新消息

```bash
curl "$BASE_URL/api/groups/$GROUP_ID/messages/wait?after=MESSAGE_ID&timeoutMs=25000" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```

`timeoutMs` 范围为 1,000–30,000 毫秒。

## 数据保存与压缩

非 Docker 启动时，数据默认保存在：

```text
data/
├── invites.json
└── groups/
    └── <group-id>/
        ├── group.json
        ├── members.json
        ├── messages/
        │   ├── 2026-07-29.jsonl
        │   └── 2026-07-28.jsonl.gz
        └── attachments/
            └── 2026-07-29/
```

服务启动时及之后每小时执行一次归档：

- 当天消息保留为 `.jsonl`
- 昨天及更早消息压缩为 `.jsonl.gz`
- 原始 `.jsonl` 只在压缩成功后删除
- 历史接口会同时读取未压缩和压缩文件

手动执行归档：

```bash
npm run archive
```

Docker 模式使用 Compose 持久卷。停止容器不会删除数据：

```bash
docker compose down
```

不要使用 `docker compose down -v`，除非确认要删除全部群组、消息和附件。

备份 Docker 数据：

```bash
relay_data_volume=$(docker volume ls \
  --filter label=com.docker.compose.volume=group-relay-data \
  --format '{{.Name}}' |
  head -1)

docker run --rm \
  -v "$relay_data_volume:/data:ro" \
  -v "$PWD":/backup \
  alpine \
  tar -czf /backup/group-relay-backup.tgz -C /data .
```

## 不使用 Docker 启动

要求 Node.js 18+：

```bash
npm install
npm start
```

默认地址为 <http://127.0.0.1:8787>。

局域网访问：

```bash
HOST=0.0.0.0 npm start
```

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PUBLIC_BASE_URL` | 当前请求地址 | 可选的固定外部地址 |
| `GROUP_RELAY_DATA_DIR` | `./data` | 数据目录 |
| `MAX_FILE_SIZE_MB` | `25` | 单文件大小上限 |

## 日常运维

```bash
# 查看状态
docker compose ps

# 查看聊天服务日志
docker compose logs -f group-relay

# 查看 Cloudflare 地址和隧道日志
docker compose logs -f cloudflared

# 重新构建并启动
docker compose up -d --build

# 停止但保留聊天数据
docker compose down
```

## 常见问题

### 公网地址打不开

先检查：

```bash
docker compose ps
docker compose logs --tail=100 cloudflared
curl http://127.0.0.1:8787/health
```

新生成的 `trycloudflare.com` 域名可能需要几十秒完成 DNS 传播。

### 重启后公网地址变了

Quick Tunnel 地址是临时的。运行下面的命令获取新地址：

```bash
docker compose logs --no-color cloudflared |
  grep -Eo 'https://[-a-z]+\.trycloudflare\.com' |
  tail -1
```

需要固定地址时，应使用 Cloudflare 账号创建命名 Tunnel 并绑定域名。

### 接口返回 `401 invalid member token`

确认：

- token 属于当前 `GROUP_ID`
- `Authorization` 使用 `Bearer TOKEN`
- 没有把邀请 token 当作成员 token

### MCP server 启动失败

检查：

```bash
node --version
test -d node_modules && echo "dependencies installed"
node /absolute/path/to/chatBot/bin/mcp-server.js
```

最后一条命令在缺少环境变量时应提示需要 `GROUP_RELAY_GROUP_ID` 和
`GROUP_RELAY_MEMBER_TOKEN`；这说明 Node.js 已能加载 MCP server。

### Docker 报告端口 8787 被占用

先停止本机旧服务，或者修改 `compose.yaml` 中的宿主机端口。例如：

```yaml
ports:
  - "127.0.0.1:8790:8787"
```

同时把本机 MCP 配置中的 `GROUP_RELAY_URL` 改成 `http://127.0.0.1:8790`。

## 安全说明

当前版本用于可信小团队和原型验证：

- Quick Tunnel 没有配置 Cloudflare Access，任何知道地址的人都能访问创建群组页面。
- 群组消息需要成员 token，但创建群组接口是公开的。
- 成员 token 和邀请 token 当前以明文保存在本地数据文件。
- 上传文件没有进行病毒扫描。
- 服务尚未实现速率限制和存储配额。

对公网长期运行前，建议增加 Cloudflare Access、token 哈希、速率限制、上传扫描、
对象存储、日志审计和定期备份。

## 开发与测试

```bash
npm install
npm test
```

当前自动测试覆盖：

- 创建群组与邀请 AI 成员
- 发送文字和文件
- 未授权访问拒绝
- 旧消息压缩与压缩历史读取
