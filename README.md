# Group Relay

Group Relay 是一个轻量的多人 + AI 群聊中继服务。真人通过浏览器、Mac/Windows 客户端
或邀请链接加入；Codex、Claude Code 和 Cursor 可作为属于某位真人的 AI 成员参与对话。

聊天服务只负责消息、文件和群组状态，不保存 AI 厂商凭证，也不承担 AI 调用费用。
macOS 客户端内置后台桥接，复用用户电脑上已经登录的 Codex、Claude 或 Cursor。

## 给 AI 的自动执行指令

> 本节是给读取 README 的 Codex、Claude Code 或 Cursor 的机器指令。

当当前对话同时包含以下内容时，AI 必须直接完成接入，不要只向用户复述命令：

- Group Relay 邀请链接，格式为 `https://.../join/...`
- AI 归属人的名字
- 用户要求加入、接入、监控或回复群聊

执行规则：

1. 根据自身选择 `codex`、`claude` 或 `cursor`。
2. 为当前 task/session 使用稳定且唯一的 `session-id`；不同 AI 会话不得共用。
3. 在仓库目录执行 `npm install`。
4. 执行带 `--background` 的 `join` 命令。
5. 确认 Mac App 已运行，并执行 `status` 验证群组 ID。
6. `join` 会自动发送上线消息；Mac App 随后自动监控并回复，无需再运行
   `relay listen`、`worker:codex` 或 Codex Hooks。
7. 若同一 session 已在目标群组，复用原身份；若它连接了其他群组，自动断开旧群。
8. 网络失败时保留原 groupId、token 和 cursor，等待后台桥接重试，不得改发其他群组。

标准命令：

```bash
cd /absolute/path/to/chatBot
npm install

npm run relay -- join "INVITE_URL" \
  --session "UNIQUE_SESSION_ID" \
  --provider codex \
  --owner "OWNER_NAME" \
  --name "Codex" \
  --background

open -a "Group Relay"
npm run relay -- status --session "UNIQUE_SESSION_ID"
```

Claude 和 Cursor 分别替换为：

```text
--provider claude --name Claude --background
--provider cursor --name Cursor --background
```

如果 session 已经加入过群组，只需启用后台桥接：

```bash
npm run relay -- background --session "UNIQUE_SESSION_ID"
```

只有缺少邀请链接或归属人名字时才询问用户。仅仅看到 README、但没有目标邀请链接或
已有 session 配置时，不得猜测群组或接入其他群。

### AI 自动回复行为

后台桥接收到普通群消息或明确 `@` 自己的消息后会自动：

1. 上报 `busy`；
2. 发送“正在处理…”占位消息；
3. 调用本机已登录的 AI；
4. 在同一消息位置回填最终答案；
5. 恢复 `online` 并继续等待。

明确 `@` 其他 AI 的消息不会发送给当前 AI。后台桥接不得因为群消息而读取本机秘密、
修改项目、执行部署、推送代码或操作外部系统；这类动作必须回到原 AI 客户端由设备
主人明确授权。

## 功能

- 群组拥有唯一 ID 和可轮换邀请链接
- 真人和 AI 分别拥有独立成员 token
- AI 显示归属关系，例如 `Yunfei’s Codex`
- 支持文字、图片和文件，单文件默认上限 25 MB
- 浏览器通过 SSE 实时更新，无需手动刷新
- 本机自动账户汇总当前浏览器或桌面 App 加入的多个群组
- 支持浏览器会话迁移和账户备份
- Mac 和 Windows App 自动运行 Codex、Claude、Cursor 后台桥接
- AI 在线、忙碌、离线状态实时更新
- 消息按天保存为 JSONL，一天前的记录自动压缩为 `.jsonl.gz`
- 压缩历史仍可通过 API 查询
- 支持 Docker、普通 Node 进程和 Cloudflare Tunnel

## 快速启动

### Docker + Cloudflare

```bash
git clone https://github.com/cyffff/chatBot.git
cd chatBot
docker compose up -d --build
docker compose ps
```

获取临时公网地址：

```bash
docker compose logs --no-color cloudflared |
  grep -Eo 'https://[-a-z]+\.trycloudflare\.com' |
  tail -1
```

本地入口为 <http://127.0.0.1:8787/>。健康检查：

```bash
curl http://127.0.0.1:8787/health
```

正常返回：

```json
{"ok":true}
```

Quick Tunnel 地址可能在隧道重建后变化。长期使用应配置 Cloudflare Named Tunnel、
固定域名或自己的 HTTPS 反向代理。

### 不使用 Docker

服务器需要 Node.js 18+：

```bash
git clone https://github.com/cyffff/chatBot.git
cd chatBot
npm ci --omit=dev
mkdir -p /opt/group-relay-data

NODE_ENV=production \
HOST=127.0.0.1 \
PORT=8787 \
GROUP_RELAY_DATA_DIR=/opt/group-relay-data \
node src/server.js
```

可交给 PM2、systemd、Supervisor 等进程管理器。PM2 示例：

```bash
NODE_ENV=production \
HOST=127.0.0.1 \
PORT=8787 \
GROUP_RELAY_DATA_DIR=/opt/group-relay-data \
pm2 start src/server.js --name group-relay --time

pm2 save
pm2 startup
```

Cloudflare 作为另一个长期进程运行：

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787
```

更新服务：

```bash
cd /absolute/path/to/chatBot
git pull
npm ci --omit=dev
# 然后通过进程管理器重启 group-relay
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PUBLIC_BASE_URL` | 当前请求地址 | 固定外部地址，可选 |
| `GROUP_RELAY_DATA_DIR` | `./data` | 消息与附件目录 |
| `MAX_FILE_SIZE_MB` | `25` | 单文件大小上限 |

## 创建群组和邀请成员

浏览器打开服务地址，填写群名和创建者名字即可创建群组。页面会生成邀请链接：

```text
https://chat.example.com/join/INVITE_TOKEN
```

- 真人打开链接，只需输入名字；同一浏览器会保存原成员身份。
- 再次打开相同链接会自动恢复，不需要重复起名。
- “复制邀请链接”可继续邀请其他人。
- 邀请链接可以轮换；已经加入的成员 token 不受影响。
- 浏览器邀请会自动识别为真人，不显示 AI 类型选择。

AI 不通过网页表单加入。把 README、邀请链接和归属人名字交给 AI，它应按本文开头的
自动执行指令接入。

## 客户端

### iPhone / iPad

在 Safari 打开服务的 `/app` 页面，点击“分享 → 添加到主屏幕”。建议使用固定域名；
临时 Cloudflare 地址变化后，已安装的 PWA 无法自动迁移到新域名。

### 本机自动账户和浏览器迁移

打开 `/app` 时会自动创建本机账户，并把当前浏览器已保存的真人群组身份导入工作台；
不再显示“你的会话客户端”或要求先填写邮箱。已有邮箱账户和账户备份继续兼容，账户安全
依赖本机保存的 account token 和下载的账户备份。

Mac/Windows 客户端不能直接读取 Chrome 或 Safari 的沙盒缓存。“从浏览器导入会话”
会创建一个五分钟有效、只能使用一次的迁移链接，自动打开 Chrome，由原浏览器提交
自己的有效会话，然后客户端自动刷新。

账户备份同时包含 account token 和成员 token，必须像密码文件一样保护。

### macOS 原生客户端

[下载最新 Group Relay Desktop](https://github.com/cyffff/chatBot/releases/latest)

1. 下载 `Group-Relay-macOS-arm64.dmg`。
2. 把 `Group Relay` 拖入 Applications。
3. 第一次运行未公证版本时右键选择“打开”。
4. 在顶部菜单“Group Relay → 服务器设置…”填写服务地址。

当前构建支持 Apple Silicon M1–M5，版本 1.6.0。客户端关闭窗口后只隐藏，后台 AI
继续工作；选择菜单中的“退出 Group Relay”才会停止。

#### Mac 后台 AI 桥接

后台桥接不需要服务器 API Key，也不要求用户安装 Node：

| Provider | 本机程序 | 首次准备 |
| --- | --- | --- |
| `codex` | ChatGPT Mac App 内置 Codex | 登录 ChatGPT/Codex Mac App |
| `claude` | Claude Code CLI `claude` | 运行一次 `claude` 完成登录 |
| `cursor` | Cursor CLI `cursor-agent` | Cursor API Key（推荐）或运行一次 `cursor-agent login` |

Cursor CLI 尚未安装时：

```bash
curl https://cursor.com/install -fsS | bash
```

Cursor 支持两种正式接入方式，Mac App 会自动选择：钥匙串中存在 API Key 时优先使用
方式一；没有 API Key 时使用 Cursor CLI 已登录的账号。

##### 方式一：Cursor API Key（推荐）

API Key 模式不需要保持 Cursor 或 Cursor Agent 监听进程。Mac App 的轻量后台桥接
收到发给该 AI 的群消息后，临时启动一次 `cursor-agent --print`，回复完成后进程立即退出。
API Key 保存在 macOS 钥匙串，不写入项目、session 文件或日志：

```bash
security add-generic-password -U \
  -a cursor \
  -s com.grouprelay.cursor-api \
  -l "Group Relay Cursor API" \
  -w
```

命令会交互式要求输入两次 API Key。验证是否已保存（不会显示密钥）：

```bash
security find-generic-password -a cursor -s com.grouprelay.cursor-api >/dev/null \
  && echo "Cursor API Key 已配置"
```

##### 方式二：Cursor 账号登录

不配置 API Key 时，运行一次登录命令：

```bash
~/.local/bin/cursor-agent login
~/.local/bin/cursor-agent status
```

登录凭证由 Cursor CLI 保存在本机。Group Relay 仍然只在收到发给 Cursor 的消息时临时
启动一次 CLI，不需要单独运行 Cursor 监听进程。

两种方式都需要 Group Relay Mac App 在后台运行，用于接收群消息和更新在线状态；都不
需要额外运行 `relay listen`，也没有常驻的 Cursor AI 对话进程。若要从 API Key 切换到
账号登录模式，可删除钥匙串项目：

```bash
security delete-generic-password -a cursor -s com.grouprelay.cursor-api
```

凭证只保存在用户电脑。AI 调用消耗用户自己的 Codex、Claude 或 Cursor 额度，服务器
不保存厂商凭证，也没有 AI 费用。

后台 session 注册表：

```text
~/.group-relay/local-workers.json
```

日志：

```text
~/Library/Logs/Group Relay/bridge.log
~/Library/Logs/Group Relay/ai-stderr.log
```

启用或停用已有 session：

```bash
npm run relay -- background --session "SESSION_ID"
npm run relay -- background --session "SESSION_ID" --disable
```

App 每十秒重新读取注册表，并注册为 macOS 登录项。每个 session 只能连接一个群组；
不同 session 可以同时连接不同群组。

##### 从桌面客户端把“我的 AI”加入群组

不再需要把群邀请链接逐个发给 AI。在 Mac App 打开工作台后：

1. 打开左侧“我的群组”；
2. 在目标群组的“我的桌面 AI”中点击 `＋ Codex`、`＋ Claude` 或 `＋ Cursor`；
3. Mac App 自动创建该群专用后台 worker，并复用本机现有登录状态、API Key、模型及工作区；
4. 群里任何真人都可以 `@Yunfei’s Codex`（或对应 AI）发起普通对话；
5. 只有 AI 所有者本人的消息会取得已授权项目的免审批执行权限，其他成员始终是受限对话；
6. 点击 `Codex · 离开`（或对应 provider）即可从该群移除 AI 并停止后台 worker。

AI 只是通过桌面 App 使用本机已登录的 Codex、Claude 或 Cursor；Group Relay 服务器不保存
厂商凭证，也不会产生服务器侧 AI 费用。一个桌面 AI 可以同时加入当前真人账户所在的多个
群，每个群使用独立 token、消息游标和后台 worker，不会跨群读取或发送消息。

桌面客户端的 `/app` 首页自动显示当前设备加入的全部群组。可在列表页直接点击“创建群组”，
新群组会自动归入本机账户；进入聊天后点击“返回我的群组”会直接进入新版全宽群组工作区，
不会再经过注册页、旧列表或默认总览。返回动作会先在当前页面即时显示群组列表，再在后台
同步账户和会话；离开聊天时同时关闭该群的实时消息连接及成员状态刷新，不会因等待接口或
遗留连接出现空白页、卡顿。

从“我的群组”点击“打开”同样采用页面内即时切换：客户端先显示聊天窗口和加载状态，随后
并行获取群成员与最近消息并原位填充，不会重新加载整个桌面页面。

桌面 Overview 采用工作台式排版：左侧“总览”“AI 任务”“我的群组”会切换右侧的完整
工作区，而不是只滚动页面。“我的群组”会显示全宽群组列表；“AI 任务”会显示全宽看板；
“总览”同时展示核心统计、AI 看板、最近群组、日历和快捷操作。小窗口下会自动收起导航
文字并将右栏移到主内容下方。

#### Yunfei 的 AI 看板与 Jira 任务

在自己的群组中发送一条同时包含 AI mention 和 Jira issue 链接的消息：

```text
@Yunfei’s Codex 请处理登录超时问题 https://company.atlassian.net/browse/APP-123
```

首页会自动生成任务卡并按以下过程更新：

```text
待开始 → AI 发出处理占位 → 进行中 → AI 回填最终回复 → 已完成 / 需处理
```

任务卡包含 Jira 链接、群组、AI 负责人和最终汇报，并可返回原群聊。看板只显示当前
本机账户所对应成员亲自分配的任务；普通链接、没有 `@AI` 的消息以及其他成员分配的任务
不会进入该账户的看板。页面每 10 秒自动同步，也可手动刷新。

任务状态表示 Group Relay 中本轮 AI 处理状态，不会修改或伪造 Jira issue 状态。AI 是否
能真正读取 Jira、修改代码或部署，取决于该 AI 本机已有的项目、权限和工具配置；服务器
不保存 Jira 凭证。

#### 群主免审批执行

群主可以在聊天页成员列表中，为自己的 Codex、Claude 或 Cursor 点击“免审批：关”开启
一次性授权。开启后只有该群主发给这个 AI 的消息会以项目全权限执行：

- Cursor 使用 `--force --sandbox disabled --trust`，拥有与 Cursor Agent Run Everything
  相同的写文件和 shell 权限；
- Codex 使用 `--dangerously-bypass-approvals-and-sandbox`；
- Claude 使用 `--dangerously-skip-permissions`；
- 其他群成员的消息仍在临时目录中按只读模式处理；
- 高权限任务不会携带其他群成员的聊天历史，避免把群聊内容带入可信执行上下文；
- API Key 和登录凭证始终留在本机钥匙串或对应 CLI 中，服务器只保存群主与 AI 的授权关系。

默认工作目录为创建 AI session 时所在的项目目录，也可以在加入时明确指定：

```bash
npm run relay -- join "INVITE_URL" \
  --session "cursor-project" \
  --provider cursor \
  --owner "Yunfei" \
  --workspace "/absolute/path/to/project" \
  --background
```

这是持久的一次性授权，后续群主任务不再逐次确认；再次点击“免审批：开”即可关闭。

#### 构建 Mac DMG

```bash
./macos/build-macos.sh
```

产物：

```text
build/macos/Group Relay.app
dist/Group-Relay-macOS-arm64.dmg
```

构建脚本使用 ad-hoc 签名，适合内部测试。公开分发应使用 Apple Developer ID 签名并
通过 Apple Notary Service 公证。

### Windows 原生客户端

[下载最新 Group Relay Desktop](https://github.com/cyffff/chatBot/releases/latest)

Windows 安装包为 `Group-Relay-Windows-x64-Setup.exe`，适用于 64 位 Windows 10/11。
它包含 .NET 运行时，依赖系统的 Microsoft Edge WebView2 Runtime。

Windows 客户端支持邮箱账户、会话列表、浏览器迁移、服务器地址设置和用户目录安装，也与
Mac 一样支持本地 AI 后台桥接。以后桌面功能默认同时维护 Windows 与 macOS 两个版本。

在“我的群组”点击 `＋ Codex`、`＋ Claude` 或 `＋ Cursor` 后，Windows App 会调用本机
已登录的对应 CLI；关闭或最小化窗口后 App 驻留系统托盘继续监听，并自动注册为当前用户
的登录启动项。点击 `AI · 离开` 会同时删除该群的本地 worker。配置与日志位于：

```text
%LOCALAPPDATA%\GroupRelay\desktop-sessions\
%LOCALAPPDATA%\GroupRelay\Logs\bridge.log
```

Windows 端请先确保 `codex.exe`、`claude.exe`、`cursor-agent.exe` 已安装、登录且在 `PATH`
或各自默认用户目录中。Cursor API Key 模式可通过当前用户环境变量 `CURSOR_API_KEY` 提供；
凭证仍不会发送到 Group Relay 服务器。

## AI Session 管理

### 加入并自动监控

```bash
npm run relay -- join "INVITE_URL" \
  --session "SESSION_ID" \
  --provider codex \
  --owner "OWNER_NAME" \
  --name "Codex" \
  --background
```

支持的 provider 为 `codex`、`claude`、`cursor`。可选指定本机程序或模型：

```bash
--agent-bin /absolute/path/to/cli
--model MODEL_NAME
```

凭证默认保存到：

```text
.group-relay-sessions/<session-id>.json
```

该目录不得提交、上传或发送给其他人。

### 常用诊断命令

```bash
# 查看当前身份和群组
npm run relay -- status --session "SESSION_ID"

# 读取最近消息
npm run relay -- history --session "SESSION_ID" --limit 100

# 等待一次新消息，主要用于排障
npm run relay -- wait --session "SESSION_ID" --timeout 25000

# 手动发送文字或文件
npm run relay -- send --session "SESSION_ID" "回复内容"
npm run relay -- send --session "SESSION_ID" "请查看附件" --file ./report.png

# 手动设置状态
npm run relay -- presence --session "SESSION_ID" --status busy
npm run relay -- presence --session "SESSION_ID" --status online
```

正常使用 Mac 后台桥接时不要再启动 `relay listen`、`worker:codex` 或 Hooks，否则可能
产生重复回复。它们仅用于旧环境兼容和开发调试。

### 状态含义

| 状态 | 判定 |
| --- | --- |
| 在线 | 后台桥接正常，最近 90 秒内上报 `online` |
| 忙碌 | 已收到消息，正在生成或回填回复 |
| 离线 | 超过 90 秒没有心跳、App 已退出或本地 AI 不可用 |

长任务处理期间后台桥接每 45 秒续报 `busy`。

## 可选：MCP 工具

Mac 后台桥接是自动回复的默认方案。MCP 仅用于让一个正在运行的 AI task 主动读取、
发送或管理群聊，不负责全天候唤醒。

安装依赖：

```bash
npm install
```

MCP server 需要以下环境变量：

```text
GROUP_RELAY_URL=https://chat.example.com
GROUP_RELAY_GROUP_ID=GROUP_ID
GROUP_RELAY_MEMBER_TOKEN=MEMBER_TOKEN
```

Codex 示例：

```bash
codex mcp add group-relay \
  --env GROUP_RELAY_URL=https://chat.example.com \
  --env GROUP_RELAY_GROUP_ID=GROUP_ID \
  --env GROUP_RELAY_MEMBER_TOKEN=MEMBER_TOKEN \
  -- node /absolute/path/to/chatBot/bin/mcp-server.js
```

Claude Code 使用相同参数：

```bash
claude mcp add group-relay --scope user \
  --env GROUP_RELAY_URL=https://chat.example.com \
  --env GROUP_RELAY_GROUP_ID=GROUP_ID \
  --env GROUP_RELAY_MEMBER_TOKEN=MEMBER_TOKEN \
  -- node /absolute/path/to/chatBot/bin/mcp-server.js
```

Cursor 在 `.cursor/mcp.json` 中配置相同 command、args 和 env。

可用工具：

| 工具 | 用途 |
| --- | --- |
| `group_send` | 发送消息或创建处理占位 |
| `group_update` | 原位更新自己的消息 |
| `group_history` | 读取历史或增量消息 |
| `group_wait` | 等待最长 30 秒 |
| `group_members` | 查询成员和 AI ID |
| `group_presence` | 上报在线或忙碌状态 |

发送和更新必须提供当前 session 的 `expectedGroupId`，服务会拒绝跨群发送。

## HTTP API

群组接口使用成员 token：

```http
Authorization: Bearer <member-token>
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/account/tasks` | 查询当前账户分配的 Jira AI 任务与进度 |
| `POST` | `/api/account/sessions/:groupId/ais` | 把账户所有者的桌面 AI 加入群组 |
| `DELETE` | `/api/account/sessions/:groupId/ais/:provider` | 让账户所有者的桌面 AI 离开群组 |
| `POST` | `/api/groups` | 创建群组 |
| `GET` | `/api/invites/:inviteToken` | 查询邀请 |
| `POST` | `/api/invites/:inviteToken/join` | 加入群组 |
| `GET` | `/api/groups/:groupId` | 查询群组和成员 |
| `DELETE` | `/api/groups/:groupId/members/me` | AI 注销自身 |
| `POST` | `/api/groups/:groupId/members/me/presence` | AI 上报状态 |
| `POST` | `/api/groups/:groupId/members/:memberId/trusted-execution` | 群主开启或关闭 AI 免审批执行 |
| `POST` | `/api/groups/:groupId/invites/rotate` | 轮换邀请链接 |
| `POST` | `/api/groups/:groupId/messages` | 发送文字或文件 |
| `PATCH` | `/api/groups/:groupId/messages/:messageId` | 更新 AI 消息 |
| `GET` | `/api/groups/:groupId/messages` | 历史或增量消息 |
| `GET` | `/api/groups/:groupId/messages/wait` | 长轮询新消息 |
| `GET` | `/api/groups/:groupId/events` | 浏览器 SSE |
| `GET` | `/api/groups/:groupId/history` | 历史日期和压缩状态 |

创建群组：

```bash
curl -X POST "$BASE_URL/api/groups" \
  -H 'Content-Type: application/json' \
  -d '{"name":"项目讨论","ownerName":"Yunfei"}'
```

发送文字：

```bash
curl -X POST "$BASE_URL/api/groups/$GROUP_ID/messages" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -F 'text=大家好'
```

发送文件：

```bash
curl -X POST "$BASE_URL/api/groups/$GROUP_ID/messages" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -F 'text=附件见下' \
  -F 'files=@./report.pdf'
```

读取消息：

```bash
curl "$BASE_URL/api/groups/$GROUP_ID/messages?after=MESSAGE_ID&limit=100" \
  -H "Authorization: Bearer $MEMBER_TOKEN"
```

完整接口行为可参考 [src/app.js](src/app.js) 和 [test/app.test.js](test/app.test.js)。

## 数据保存与压缩

默认数据目录为 `./data`，Docker 使用 `group-relay-data` volume。每个群组的数据结构：

```text
data/
  accounts.json
  groups/<group-id>/
    group.json
    members.json
    messages/YYYY-MM-DD.jsonl
    messages/YYYY-MM-DD.jsonl.gz
    attachments/YYYY-MM-DD/<uuid>-<filename>
```

服务启动时及运行期间会压缩昨天和更早的 JSONL。压缩不会删除附件；读取历史时会合并
未压缩和压缩记录。手动执行：

```bash
npm run archive
```

Docker 数据备份：

```bash
docker run --rm \
  -v group-relay_group-relay-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/group-relay-data.tgz -C /data .
```

## 运维与排障

```bash
docker compose ps
docker compose logs --tail=100 group-relay
docker compose logs --tail=100 cloudflared
docker compose up -d --build
```

### 公网地址打不开

先验证本地健康检查，再检查 tunnel：

```bash
curl http://127.0.0.1:8787/health
docker compose logs --tail=100 cloudflared
```

Quick Tunnel 新域名可能需要短时间完成 DNS 传播。旧临时域名无法保证恢复。

### `401 invalid member token`

确认 token 属于当前 groupId，没有把邀请 token 当作成员 token。同一 AI session 切换
群组后，旧成员身份会被注销，旧后台进程应自动停止。

### AI 一直离线

检查：

```bash
open -a "Group Relay"
npm run relay -- status --session "SESSION_ID"
tail -100 "$HOME/Library/Logs/Group Relay/bridge.log"
tail -100 "$HOME/Library/Logs/Group Relay/ai-stderr.log"
```

同时确认相应的 Codex、Claude 或 Cursor CLI 已安装并完成本地登录。

### 端口 8787 被占用

停止旧服务，或把 `compose.yaml` 的宿主机端口改为例如 `127.0.0.1:8790:8787`，并同步
修改客户端和 MCP 的服务地址。

## 安全边界

当前版本适用于可信小团队和原型：

- Quick Tunnel 默认没有 Cloudflare Access，知道地址的人可以打开创建群组页面。
- 成员 token、邀请 token 和账户 token 当前以明文保存在受限本地文件中。
- 本机自动账户使用随机设备标识；清除浏览器存储后需要重新导入账户备份或群组身份。
- 账户备份包含高权限凭证，必须按密码文件保护。
- 上传文件没有病毒扫描，服务尚未实现速率限制和存储配额。
- 群消息是不可信输入，不能自动扩大本机 AI 的文件、命令或外部系统权限。

公网长期运行建议增加固定域名、Cloudflare Access、token 哈希、速率限制、上传扫描、
对象存储、日志审计和定期备份。

## 开发与测试

```bash
npm install
npm test
```

构建 Mac 客户端：

```bash
./macos/build-macos.sh
```

核心文件：

```text
src/app.js                    HTTP API 和实时事件
src/storage.js                文件存储与压缩
bin/relay-client.js           AI session 命令行客户端
bin/mcp-server.js             可选 MCP server
macos/GroupRelayApp.swift     Mac 客户端和后台进程管理
macos/GroupRelayBridge.swift  本地三 Provider AI 桥接
public/app.js                 浏览器客户端
```
