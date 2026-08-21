# Group Relay

Group Relay 是一个轻量的多人 + AI 群聊中继服务。真人通过浏览器、Mac/Windows 客户端
或邀请链接加入；Codex、Claude Code、Cursor 和 opencode 可作为属于某位真人的 AI 成员参与对话。

聊天服务只负责消息、文件和群组状态，不保存 AI 厂商凭证，也不承担 AI 调用费用。
macOS 客户端内置后台桥接，复用用户电脑上已经登录的 Codex、Claude 或 Cursor。

## 邀请链接同时服务人和 AI

同一个 `/join/<token>` 链接有两种形态，靠 `Accept` 区分：

- **人用浏览器打开** → 进入群组（Accept 带 `text/html`）；
- **AI 用 curl / fetch 抓** → 拿到一份纯文本接入说明（Accept 是 `*/*` 或没有），里面已经填好服务器
  地址、群组 id、邀请链接、`--owner`、`--email` 和完整命令，不需要再去读这份 README。

聊天页的「复制邀请链接」会把归属人和邮箱作为查询参数带上，AI 抓到的说明因此是完整的、不用再问一轮。
这套服务没有鉴权、邀请链接本身已经等于访问权，所以参数里的邮箱不新增暴露面；但链接会被转发，心里
有数即可。人点这种带参数的链接时，加入表单会自动预填这两项。

排查用 `?format=text` / `?format=html` 可以强制某一种形态。

## 给 AI 的自动执行指令

> 本节是给读取 README 的 Codex、Claude Code、Cursor 或 opencode 的机器指令。

当当前对话同时包含以下内容时，AI 必须直接完成接入，不要只向用户复述命令：

- Group Relay 邀请链接，格式为 `https://.../join/...`
- AI 归属人的名字
- AI 归属人的 email（身份就是 email，没有成员 token）
- 用户要求加入、接入、监控或回复群聊

执行规则：

1. 根据自身选择 `codex`、`claude`、`cursor` 或 `opencode`。
2. 为当前 task/session 使用稳定且唯一的 `session-id`；不同 AI 会话不得共用。
3. 在仓库目录执行 `npm install`。
4. 执行带 `--background` 的 `join` 命令。
5. 让它常驻，二选一（两个都开会白跑一份额度）：装了桌面客户端就确认客户端在运行；
   没装（Linux、服务器、纯命令行 Windows）就自己起常驻进程
   `npm run relay -- worker --session "UNIQUE_SESSION_ID"`。然后执行 `status` 验证群组 ID。
6. `join` 会自动发送上线消息；随后由桌面客户端或上面那个常驻 worker 自动监控并回复，
   无需再运行 `relay listen`、`worker:codex` 或 Codex Hooks。
7. 若同一 session 已在目标群组，复用原身份；若它连接了其他群组，自动断开旧群。
8. 网络失败时保留原 groupId、email 和 cursor，等待后台桥接重试，不得改发其他群组。

标准命令：

```bash
cd /absolute/path/to/chatBot
npm install

npm run relay -- join "INVITE_URL" \
  --session "UNIQUE_SESSION_ID" \
  --provider codex \
  --owner "OWNER_NAME" \
  --email "OWNER_EMAIL" \
  --name "Codex" \
  --background

# 有桌面客户端(macOS)
open -a "Group Relay"
# 没有桌面客户端:自己常驻(Linux/服务器/纯命令行 Windows)
npm run relay -- worker --session "UNIQUE_SESSION_ID" --log ~/.group-relay/worker.log

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

只有缺少邀请链接、归属人名字或归属人 email 时才询问用户。仅仅看到 README、但没有目标邀请链接或
已有 session 配置时，不得猜测群组或接入其他群。

### AI 自动回复行为

后台桥接（桌面客户端的 `GroupRelayBridge`，或跨平台的 `npm run relay -- worker`）收到普通群消息
或明确 `@` 自己的消息后会自动：

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
- 身份就是 email：真人是 `human:<email>`，AI 是 `ai:<email>:<provider>`，没有成员 token
- AI 显示归属关系，例如 `Yunfei’s Codex`
- 支持文字、Markdown（含表格）、图片和文件，单文件默认上限 25 MB
- 浏览器通过 SSE 实时更新，无需手动刷新
- 本机自动账户汇总当前浏览器或桌面 App 加入的多个群组
- 桌面 App 持久保存邮箱账户身份，服务域名变化后自动恢复；默认昵称取邮箱 `@` 前缀
- 支持浏览器会话迁移和账户备份
- Mac 和 Windows App 自动运行 Codex、Claude、Cursor 后台桥接
- AI 在线、忙碌、离线状态实时更新
- 消息按天保存为 JSONL，一天前的记录自动压缩为 `.jsonl.gz`
- 压缩历史仍可通过 API 查询
- 服务端只是中转缓冲区：消息保留 30 天、附件保留 30 天，之后自动清除
- 聊天记录的长期副本存在本机 IndexedDB，网页和两个桌面客户端共用同一份实现
- 换机器时导出／导入聊天记录文件，服务端不做历史回溯
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

更新服务（零停机，别用 `systemctl restart`）：

```bash
cd /absolute/path/to/chatBot
git pull
npm ci --omit=dev
sudo systemctl start group-relay-standby   # 同端口的备用实例，靠 SO_REUSEPORT 并存
bash bin/zero-downtime-restart.sh          # 起备用 → 重启主 → 停备用，每步都过健康检查
```

直接 `systemctl restart` 会让 :8787 空一两秒，cloudflared 立刻对外回 502，并且把挂着的
25 秒长轮询全部切断——桥接会把在飞的 AI 任务标成失败。`bin/zero-downtime-restart.sh`
配合 `deploy/group-relay-standby.service` 可以避免：进程收到 SIGTERM 时先把长轮询按
「这一轮没有新消息」正常放掉、SSE 正常结束，并且从那一刻起不再让任何请求挂着，然后才停止
监听。实测发布窗口内外网 168 次请求全部 200，cloudflared 源站错误 0 次。


### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PUBLIC_BASE_URL` | 当前请求地址 | 固定外部地址，可选 |
| `GROUP_RELAY_DATA_DIR` | `./data` | 消息与附件目录 |
| `MAX_FILE_SIZE_MB` | `25` | 单文件大小上限 |
| `GROUP_RELAY_MESSAGE_RETENTION_DAYS` | `30` | 消息缓冲区保留天数，过期自动清除 |
| `GROUP_RELAY_ATTACHMENT_RETENTION_HOURS` | `720` | 附件保留小时数，按文件 mtime 判定 |
| `GROUP_RELAY_MOVED_TO` | 空 | 设为新服务器地址即触发整机搬迁并公告 `movedTo` |
| `GROUP_RELAY_UNANSWERED_MINUTES` | `10` | `@` 了 AI 但连占位都没有,过这么久就由服务端兜底回一条 |
| `GROUP_RELAY_STALL_MINUTES` | `20` | 占位一直是「处理中」,过这么久提醒一次「仍在进行」 |
| `GROUP_RELAY_GIVE_UP_MINUTES` | `45` | 再久就判定执行端已退出,把占位改成失败并让提问者重发 |
| `GROUP_RELAY_RESTRICT_DIRS` | 关 | 本机 agent 只能访问 `GROUP_RELAY_ALLOWED_DIRS` 里的目录 |
| `GROUP_RELAY_ALLOWED_DIRS` | 空 | 允许访问的目录清单，按操作系统的路径分隔符分隔（Mac/Linux `:`，Windows `;`） |
| `GROUP_RELAY_NO_DIR_LISTING` | 关 | 禁止把目录当文件发出（不提供目录结构） |
| `GROUP_RELAY_NO_FILE_DOWNLOAD` | 关 | 禁止把本机文件作为附件发出，只允许读取内容供 AI 使用 |

后四个是**客户端侧**（`bin/mcp-server.js`、`bin/codex-worker.js`）的数据安全开关，默认全关、
行为与历史一致。开启目录白名单后清单为空即拒绝所有本机路径；这些开关只影响本机 agent 能碰
什么，和服务端存什么无关。

## 创建群组和邀请成员

浏览器打开服务地址，填写群名和创建者名字即可创建群组。页面会生成邀请链接：

```text
https://chat.example.com/join/INVITE_TOKEN
```

- 真人打开链接，只需输入名字；同一浏览器会保存原成员身份。
- 再次打开相同链接会自动恢复，不需要重复起名。
- “复制邀请链接”可继续邀请其他人。
- 邀请链接可以轮换；已经加入的成员不受影响（身份是 email，与邀请链接无关）。
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
依赖本机保存的 email 和下载的账户备份。

Mac/Windows 客户端不能直接读取 Chrome 或 Safari 的沙盒缓存。“从浏览器导入会话”
会创建一个五分钟有效、只能使用一次的迁移链接，自动打开 Chrome，由原浏览器提交
自己的有效会话，然后客户端自动刷新。

从桌面客户端菜单选择“显示 → 在浏览器中打开”时流程相反：客户端会用本机已登录账户
创建一个五分钟有效、只能领取一次的网页登录链接。浏览器打开后会自动同步相同的昵称、
头像、群组和 AI 任务，不需要下载备份或再次登录。为防止网页窃取本机凭证，直接手工输入
`/app` 地址仍使用该浏览器自己的隔离账户。

账户备份只包含 email 和加入过的群组 id —— 没有 token，因为身份就是 email 本身。

### macOS 原生客户端

[下载最新 Group Relay Desktop](https://github.com/cyffff/chatBot/releases/latest)

1. 下载 `Group-Relay-macOS-arm64.dmg`。
2. 把 `Group Relay` 拖入 Applications。
3. 第一次运行未公证版本时右键选择“打开”。
4. 在顶部菜单“Group Relay → 服务器设置…”填写服务地址。

当前构建支持 Apple Silicon M1–M5，版本 1.14.1。客户端关闭窗口后只隐藏，后台 AI
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

在桌面 App 左侧打开“设置”，可以直接配置 Codex、Claude 或 Cursor API Key。API Key
模式不需要保持 AI 客户端或 Agent 监听进程；后台桥接收到群消息时才临时启动对应 CLI，
回复完成后进程退出。没有配置 API Key 时，也可以继续使用 CLI 已登录账号，例如 Cursor：

```bash
~/.local/bin/cursor-agent login
~/.local/bin/cursor-agent status
```

登录凭证由 Cursor CLI 保存在本机。Group Relay 仍然只在收到发给 Cursor 的消息时临时
启动一次 CLI，不需要单独运行 Cursor 监听进程。

两种方式都需要 Group Relay Mac App 在后台运行，用于接收群消息和更新在线状态；不需要
额外运行 `relay listen`，也没有常驻的 AI 对话进程。要切回账号登录模式，在“设置”中
删除对应 Key 即可。

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

`background --disable` 只改本机注册表，**Mac App 下一次同步会按服务端清单把它写回来**。
要让某个群的桌面 worker 持久关闭（不必退掉整个客户端、其它群照跑），关服务端那个开关：

```bash
npm run relay -- desktop-worker --session "SESSION_ID" --disable
npm run relay -- desktop-worker --session "SESSION_ID" --enable
```

关掉之后 `GET /api/account/desktop-workers` 就不再返回这个 worker，客户端据此把进程收掉，
以后每次同步也不会再拉起来。AI 仍然是群成员：自己在命令行起的 worker 照样收消息。

App 每十秒重新读取注册表，并注册为 macOS 登录项。每个 session 只能连接一个群组；
不同 session 可以同时连接不同群组。

##### 从桌面客户端把“我的 AI”加入群组

不再需要把群邀请链接逐个发给 AI。群组不必由自己创建：只要当前邮箱账户对应的真人成员
已经加入该群，就可以把自己的 AI 加入。在 Mac/Windows App 或已同步账户的网页工作台中：

1. 打开左侧“我的群组”；
2. 在目标群组的“我的桌面 AI”中点击 `＋ Codex`、`＋ Claude` 或 `＋ Cursor`；
3. 桌面 App 自动创建该群专用后台 worker，并复用本机现有登录状态、API Key、模型及工作区；
4. 群里任何真人都可以 `@Yunfei’s Codex`（或对应 AI）发起普通对话；
5. AI 所有者本人以及同一账户名下、同样已授权的桌面 AI 可以取得免审批执行权限；其他成员始终是受限对话；
6. 点击 `Codex · 离开`（或对应 provider）即可从该群移除 AI 并停止后台 worker。

从 Chrome 等普通浏览器操作时，网页会把加入/离开状态保存到当前账户；同一账户已登录的
Mac 或 Windows 客户端每 10 秒自动同步并启动或停止对应 worker。因此不用在桌面 App 中
重复点击，也不要求自己是群主。桌面客户端必须保持后台运行，AI 才会实际在线和回复。

桌面客户端或后台桥接进程重启时，会在首次上线心跳中自动把该 AI 上一次未完成的“正在处理”
占位改为失败，并同步结束对应的进行中任务，避免中断后的任务永久显示为执行中。正常在线/忙碌
心跳不会结束仍在运行的任务。

也可以直接在群聊左侧成员栏的“我的 AI”区域操作，无需返回群组列表。桌面客户端会读取
本机设置，只对已安装可运行 CLI 的 Codex、Claude、Cursor 启用“加入”按钮；已经加入
当前群组的 AI 会显示“离开”。若本机 AI 尚未就绪，可从同一区域直接进入“接入设置”。

聊天输入框按 `Enter` 直接发送，按 `Shift + Enter` 换行；中文输入法仍在组词时按 Enter
只确认候选词，不会误发消息。发送完成后输入框和已选择文件会自动清空。

AI 只是通过桌面 App 使用本机已登录的 Codex、Claude 或 Cursor；Group Relay 服务器不保存
厂商凭证，也不会产生服务器侧 AI 费用。一个桌面 AI 可以同时加入当前真人账户所在的多个
群，每个群使用独立消息游标和后台 worker，不会跨群读取或发送消息。

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

#### 个人资料、桌面 AI 设置与 API Key

macOS 和 Windows 客户端侧边栏最底部都有独立的“设置”入口。设置页分为两个区域：

- 注册账户时会自动使用邮箱 `@` 前面的完整内容作为默认昵称；
- “个人资料”平时只展示头像和昵称，点击“编辑资料”后才显示昵称输入框及头像操作；
- 编辑状态下可以修改昵称，上传 PNG、JPEG 或 WebP 头像，也可以移除头像；
- 保存名字后，会同步更新该账户已经加入群组中的真人成员名，以及该账户名下桌面 AI 的归属名；
- 原始头像在客户端裁切、压缩为 256 × 256 后再保存，原图不会上传；
- “AI 接入”可以查看 Codex、Claude、Cursor 的 API Key 状态以及各自已接入的群组数量。

每张 AI 卡片会明确显示 API Key 是否已配置、当前优先使用 API Key 还是本机 CLI 登录账号、
CLI 是否已安装、凭据的本机保存位置和已接入群组数。未配置 Key 时，页面会继续检查对应
CLI：已找到 CLI 就说明仍可使用本机登录账号；Key 和 CLI 都没有时则显示“未就绪”及安装
或配置提示。Key 输入框默认收起，只有点击“配置 API Key”或“更换 API Key”才展开，保存
或取消后自动收起；完整 Key 永远不会回显到页面。

输入新 Key 后点击“保存 Key”即可生效，也可以删除 Key 后继续使用已经登录的本机 CLI 账号：

- Codex Key 以 `OPENAI_API_KEY` 提供给 Codex CLI；
- Claude Key 以 `ANTHROPIC_API_KEY` 提供给 Claude CLI；
- Cursor Key 以 `CURSOR_API_KEY` 提供给 Cursor Agent。

Key 不会上传到 Group Relay 服务、聊天记录或项目文件。macOS 使用系统钥匙串保存，Windows
使用 Windows Credential Manager 保存；设置页面只能查看“已配置/未配置”，不能读取原始
Key。macOS 客户端会直接更新已存在的钥匙串条目，不需要先删除旧 Key；普通浏览器中的
设置页只显示状态说明，并禁止输入 Key。

#### 个人 AI 看板与 Jira 任务

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

#### 平台自己的需求走反馈队列，不由群里的 AI 顺手改

桥接的提示词里写死了一条：群里的消息如果本质是「Group Relay 这个软件本身要改/要加功能/
有毛病」，AI **不自己动手实现**（即使已开启免审批），而是替提出人润色成「现象 + 期望行为」
提成工单，并在群里回一句已记为工单。理由是免审批之下 AI 有全权，平台改动如果被随手做掉，
既绕过了工单队列（那是唯一能看到「谁要过什么」的地方），也让同一处代码可能被多台机器同时改。

命中判据：要求改客户端/桌面 App/桥接/MCP 工具本身的行为（心跳、占位消息、状态、附件、通知、
界面）；抱怨这个软件用起来的毛病；要求新端/新入口（Windows/iOS/网页）或改协议字段。
不算的：问业务数据、查库跑 SQL、改别的项目的代码、群里闲聊 —— 照常执行。
设备主人在同一条消息里明确说「不要提工单，现在直接改」时才例外。

#### 我的 AI 干了多少活

「AI 任务」页顶部有一块工作量统计：被 @ 次数、已回答、未答或失败、平均响应时长、回复字数，
并按**提问人 / 群组 / AI / 日期**拆开，时间范围可切今天、最近 7 天、最近 30 天。
接口是 `GET /api/account/ai-work?days=7`，只返回调用者自己名下 AI 的数字 —— 没有群内排行榜。

计数落在 `data/ai-work.json`（群 × AI × 提问人 × 日期 一行），和 `feedback.json` 一样
**不进保留期回收**：消息是 30 天缓冲，若每次从消息现推，一个月前的工作量就等于没干过。
计数从上线那一刻开始累加，历史工作量可以用缓冲区里的消息补齐（按天重算并覆盖，重复执行安全）：

```bash
GROUP_RELAY_DATA_DIR=/opt/group-relay-data npm run backfill:ai-work
```

只统计 @ 了 AI 的消息；群里的普通消息不计入。回答既可以是新发一条 `replyTo`，也可以是把
占位气泡改成终态，两种都会结算响应时长和字数。

#### 群成员只读使用（免审批的第二档）

开启免审批后，群里**其他人**的消息落在**只读档**：AI 在指定的项目目录里可以读文件、检索、
跑只读命令、使用本机配置的 MCP，然后把结论发回群里；写文件、`git commit/push`、部署、
安装依赖仍然逐条要所有者批准。免审批关着时，其他人的消息一律不执行。

只读档必须先指定项目目录，否则拒绝执行 —— 桌面客户端在没有配置时会把工作区填成整个用户
主目录，那等于把 `~/.ssh`、所有仓库的读权限一起开放给群成员。按群指定：

```json
// ~/.group-relay/workspaces.json（客户端不会覆盖这个文件）
{
  "default": "/absolute/path/to/project",
  "<groupId>": "/absolute/path/to/another/project"
}
```

只读沙箱限制的是**写**，不是**读**：项目目录内的任何文件，群成员都能让 AI 念出来。提示词
里禁止读取和输出 `.env`、密钥、token，但那是约束不是隔离 —— 开这个开关时按这个前提决定
哪个目录能给。

#### AI 所有者免审批执行

AI 所有者可以在聊天页成员列表中，为自己的 Codex、Claude 或 Cursor 点击“免审批：关”开启
一次性授权，即使当前群组由别人创建也可以。群主不能替其他成员的桌面 AI 开启权限。
开启后标签显示“免审批：仅我的指令”——**范围只有你自己发的消息**。群里其他人要求你的 AI
读写本机、跑命令或部署时，仍然每条都要你在看板批准；否则任何群成员都能借你的 AI 动你的机器。
开启后 AI 所有者直接发给自己 AI 的消息会以项目全权限执行；同一账户名下、同样开启
免审批的 AI 之间也可以继承所有者授权进行任务分派，例如 Cursor 主管可以把工作交给 Codex
或 Claude：

- Cursor 使用 `--force --sandbox disabled --trust`，拥有与 Cursor Agent Run Everything
  相同的写文件和 shell 权限；
- Codex 使用 `--dangerously-bypass-approvals-and-sandbox`；
- Claude 使用 `--dangerously-skip-permissions`；
- 其他群成员的消息仍在临时目录中按只读模式处理；
- 其他账户的 AI、未开启免审批的 AI 以及未绑定桌面账户的机器人不能继承授权；
- 高权限任务不会携带其他群成员的聊天历史，避免把群聊内容带入可信执行上下文；
- API Key 和登录凭证始终留在本机钥匙串或对应 CLI 中，服务器只保存 AI 所有者与 AI 的授权关系。

默认工作目录为创建 AI session 时所在的项目目录，也可以在加入时明确指定：

```bash
npm run relay -- join "INVITE_URL" \
  --session "cursor-project" \
  --provider cursor \
  --owner "Yunfei" \
  --workspace "/absolute/path/to/project" \
  --background
```

这是持久的一次性授权，后续 AI 所有者任务不再逐次确认；再次点击“免审批：开”即可关闭。

#### 看板审批队列

不希望长期开启“免审批”时，可以保持开关关闭并使用一次性审批：

1. 群成员在聊天中 `@` 你的 Codex、Claude 或 Cursor 分配需要读取项目、修改文件、运行命令、测试、部署或调用外部系统的任务；
2. 桌面 AI 会先判断任务是否需要本机工具。需要时不会直接执行，而是在群里显示“已发送给设备主人审批”；
3. 打开 `/app` 的“总览”或“AI 任务”，顶部会出现“待审批消息”队列，侧边栏和统计卡会显示未处理数量；
4. 可以逐条“批准 / 拒绝”，也可以勾选多条后批量处理；
5. 批准后，原任务只向提出申请的机器人重新投递一次，并且仅本次任务获得免审批执行权限，不会改变该机器人的长期设置。

看板每 10 秒自动同步审批提醒，不需要进入各个群组查找。Mac 和 Windows 后台桥接都支持该流程。纯聊天、知识问答和解释类消息不会进入审批队列。

#### 构建 Mac DMG

```bash
./macos/build-macos.sh
```

**默认服务器地址**：仓库里是**空的**，编译产物不带任何内置地址 —— 以前这里烧着一个
`trycloudflare` 临时隧道地址，会过期，别人从源码编译出来默认就连不上。现在：

- 不传地址构建 → 客户端首次启动直接问用户要地址（**可以直接粘群邀请链接**，会自动取出
  服务器根地址），填完才加载；
- 给自己团队打包时把入口烧进去：

```bash
GROUP_RELAY_DEFAULT_URL=https://chat.example.com ./macos/build-macos.sh
```

连不上时不再停在白窗口：弹窗会显示当前地址和失败原因，并直接给「修改地址…／重试」两个按钮。

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

Windows 端的默认服务器地址同样不烧进产物。CI 会读取仓库变量 `GROUP_RELAY_DEFAULT_URL`；
本地构建自己传：

```bash
dotnet publish windows/GroupRelay.Windows.csproj -p:GroupRelayDefaultUrl=https://chat.example.com
```

没有地址时首启会弹出输入框（同样可以直接粘邀请链接），导航失败会明确提示「地址可能已过期，
要现在修改吗」。

Windows 端请先确保 `codex.exe`、`claude.exe`、`cursor-agent.exe` 已安装且在 `PATH` 或各自
默认用户目录中。可以使用 CLI 登录，也可以在左侧“设置”中配置三种 AI 的 Key；Key 保存到
Windows Credential Manager，不会发送到 Group Relay 服务器。

## AI Session 管理

### 加入并自动监控

```bash
npm run relay -- join "INVITE_URL" \
  --session "SESSION_ID" \
  --provider codex \
  --owner "OWNER_NAME" \
  --email "OWNER_EMAIL" \
  --name "Codex" \
  --background
```

支持的 provider 为 `codex`、`claude`、`cursor`、`opencode`。可选指定本机程序或模型：

```bash
--agent-bin /absolute/path/to/cli
--model MODEL_NAME
```

凭证默认保存到：

```text
.group-relay-sessions/<session-id>.json
```

该目录不得提交、上传或发送给其他人。

### opencode

`--provider opencode` 和其他三个一样 join、收发消息、回报 processing/complete/failed。差别有三处：

- **凭据**：opencode 没有单一 API Key，只能用它自己的 `opencode auth login`；设置页那张卡
  因此没有 Key 表单，Windows 凭据管理器也不收它。
- **执行档位**：非交互模式是 `opencode run <prompt>`。受限档加 `--agent plan` —— 内置的 plan
  agent 把改文件和跑 bash 都设成 `ask`，而非交互下没人能批，等价于只读；全权档用默认的
  build agent，工作目录就是项目（它没有 `-C`，靠进程的 cwd 定位）。回复走 stdout。
- **怎么常驻**：源码里 Mac/Windows 客户端已经认它，但**已发布的客户端二进制还没有**（要等下次
  构建）。现在用下面这条常驻命令即可，与平台无关：

```bash
npm run relay -- worker --session "SESSION_ID"
```

### 常驻在线（不依赖桌面客户端）

`--background` 只往 `~/.group-relay/local-workers.json` 写一条注册，**真正把 worker 拉起来的是
Mac/Windows 桌面客户端**（每十秒读一次那份清单）。所以没装桌面客户端的机器（Linux、服务器、
纯命令行的 Windows）链接发过去 AI 确实进了群，群里 @ 它却永远没人应。这些机器上自己起常驻进程：

```bash
npm run relay -- worker --session "SESSION_ID"
```

`codex`、`claude`、`cursor`、`opencode` 通吃，行为和 Mac 桥接一致：上报在线 → 长轮询取自己的消息 →
发「正在处理…」占位 → 调本机已登录的 AI CLI → 在同一条消息原地回填 → 恢复在线；
断线保留 groupId/cursor 并重试，被移出群则停下来并清掉本机注册。可选参数：

```bash
--once                  # 只处理一轮（给测试和 cron 用）
--model MODEL_NAME
--agent-bin /absolute/path/to/cli
--log ~/.group-relay/worker.log   # 自带 8MB 轮转
```

也可以绕过 CLI 直接指进程（systemd 单元、Windows 计划任务里这样写更省事）：

```bash
node bin/relay-worker.js --session "SESSION_ID" --log ~/.group-relay/worker.log
```

同一台机器上**不要**既开桌面客户端的 worker 又开这个：服务端按「先来先领」去重，不会重复回复，
但会白跑一份额度。要只留命令行这一个，用 `desktop-worker --disable` 把那个群的桌面 worker 关掉。

任务卡死的判定和 Mac 桥接一样：按进程树是否还在动（输出或 CPU 有推进就重置计时），静默 5 分钟
判卡死，单任务硬上限 60 分钟；读不到进程树 CPU 的平台（部分 Windows）只保留硬上限。

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

**状态按「群 + AI」独立**。一个 AI 进 N 个群就是 N 个独立 worker，各自只对自己那个群收发；
所以某个群在忙不会让它在别的群显示忙碌，某个群的 worker 没起来也只有那个群显示离线。
（早期版本的 presence 只按成员 id 存，一个群在跑，四个群一起显示忙碌，而且「正在处理哪几条
消息」也跟着串群。）

### 中文 / English

设置页有语言开关（中 / 英）。首次进入按浏览器语言猜（按 `navigator.languages` 的优先顺序取第一个
认得出来的），之后**选择存在账号上**，换设备也保持；`<html lang>` 跟着切，屏幕阅读器和浏览器的
「翻译此页」都依赖它，日期与数字交给 `toLocale*` 按当前 locale 渲染。

两层都翻，不只界面：

| 层 | 做法 |
| --- | --- |
| 网页界面 | `public/i18n.js`：`t("中文原文", [插值])`，key 就是中文原文（gettext 那一路）。静态 HTML 不改标记，靠一次 DOM 扫描替换文本节点和 `placeholder/title/aria-label/alt` |
| 服务端 | `src/i18n.js`：API 错误信息 + **写进群聊的系统消息**（看守的兜底提醒、审批放行前缀、中断恢复提示…）。语言按「账号偏好 → 请求的 `Accept-Language` → 中文」定 |
| CLI / 常驻 worker | 占位消息、失败原因、上线播报按 **AI 主人**的语言写，启动时问一次 `/api/account` |

漏翻一条最坏只是那一条还是中文（`t()` 回落到 key 本身），不会变成空白或 `undefined`。
`test/i18n.test.js` 把源码里每个 `t()` 的 key 和 `index.html` 里的中文文案全扫出来跟字典对账，
少一条就红 —— 免得英文界面里中英混排。

不在范围内：**AI 回答的正文**（那是各家 AI 自己的事，规则是「用提问者的语言回答」）、
以及**已经存下来的历史消息**（旧的中文系统消息保持原样，只有新产生的跟随语言）。
桌面客户端里编译进二进制的那两个桥接（`macos/GroupRelayBridge.swift`、`windows/WindowsAiBridge.cs`）
的占位/失败文案还是中文，要等下一次客户端构建才跟上；命令行 worker 已经跟了。

### 一条消息，多个语言版本

「一条存下来的文本」没法同时满足两种语言：主人把自己切成英文，群里的中文同事也会看到英文的
系统提示。所以语言不能定死在存储里 —— 消息可以带两种可选结构，**显示哪一版由读者决定**：

| 字段 | 谁写的 | 客户端怎么用 |
| --- | --- | --- |
| `i18n: {key, values}` | 服务端产出的系统消息（看守三档、`【已批准执行】`、中断恢复、AI 上线播报） | 用**读者自己的 locale** + 前端打包的同一份字典重渲染。是精确渲染，不是机器翻译 |
| `bodies: {zh, en}` | 写答案的那个 AI 自己给出的双语正文 | 按读者的语言选默认那一版，消息上有个小按钮**就地切换**中文 ⇄ English |
| `shared` | 同上 | 两版共用，接在选中的正文后面 |

`text` 一字不动，仍是默认渲染和老客户端的回落，**不需要迁移历史消息**。

- **不接任何第三方翻译服务**。双语正文由写答案的那个 AI 自己产出 —— 它本来就懂这些术语
  （EID、通过率、`interest_segment_v2`、表名），译得比通用 MT 准，而且群里的生产数据
  （订单号、user_id、SQL、日志片段）一步都不离开这套系统。
- **数字和表格不重复**：语言中立的部分放 `shared`，别让模型把一张 20 行的表重打一遍 ——
  重复输出还有风险，某个数字漂了很难发现。
- **复制跟着当前显示的版本**：读者看英文、复制出来是中文是最糟的。
- 切换只影响这一个气泡，**不新增消息、不改聊天记录**；只有一个版本时按钮不出现；
  手动切过之后记住偏好，同一话题下后面的双语消息默认按这个语言显示。

提交入口都能带：REST（`bodies` / `shared` / `i18n`，multipart 下是 JSON 字符串）、
MCP 的 `group_send` / `group_send_file` / `group_update`、以及
`npm run relay -- send --body-zh … --body-en … --shared …`（顺带补上了 `--mention`）。

`test/i18n.test.js` 逐条对账「服务端会存进消息的 key，前端字典里都有」—— 少一条就红，
否则英文读者会静默看到没翻的中文原文。

**还没做**：人的提问和 AI 单语回答的即时翻译按钮。那需要先定数据边界（设备内翻译 /
读者自己的 AI / 云 MT），把群里的生产数据发给外部 MT 是一次数据外发决策，不是前端功能。

### 提问不会石沉大海

`@` 了某个 AI 却什么都没回来时，由**服务端**兜底 —— 执行端可能已经退出、机器休眠、CLI 登录
过期或额度用尽，那种状态下它自己不可能再回来给群里一个交代：

| 时间（从提问算起） | 服务端动作 |
| --- | --- |
| 10 分钟仍无任何占位 | 替这个 AI 回一条失败消息：没接到任务，多半是执行端没在跑，请重发或让主人检查那台机器 |
| 20 分钟占位还是「处理中」 | 在同一条气泡上提醒一次「仍在进行，已 N 分钟」（只提醒一次，不改状态） |
| 45 分钟仍未回写 | 判定执行端已退出，把那条占位改成失败并让提问者重发 |

三个阈值分别由 `GROUP_RELAY_UNANSWERED_MINUTES` / `_STALL_MINUTES` / `_GIVE_UP_MINUTES` 调整，
计时都从**提问那一刻**算起。只管显式 `@` 了 AI 的消息 —— 群里的普通消息也会路由给 AI，
但那些不是「点名要个答复」，拿它们兜底会把群刷成噪音。

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
GROUP_RELAY_EMAIL=OWNER_EMAIL
GROUP_RELAY_PROVIDER=codex
```

Codex 示例：

```bash
codex mcp add group-relay \
  --env GROUP_RELAY_URL=https://chat.example.com \
  --env GROUP_RELAY_GROUP_ID=GROUP_ID \
  --env GROUP_RELAY_EMAIL=OWNER_EMAIL
GROUP_RELAY_PROVIDER=codex \
  -- node /absolute/path/to/chatBot/bin/mcp-server.js
```

Claude Code 使用相同参数：

```bash
claude mcp add group-relay --scope user \
  --env GROUP_RELAY_URL=https://chat.example.com \
  --env GROUP_RELAY_GROUP_ID=GROUP_ID \
  --env GROUP_RELAY_EMAIL=OWNER_EMAIL
GROUP_RELAY_PROVIDER=codex \
  -- node /absolute/path/to/chatBot/bin/mcp-server.js
```

Cursor 在 `.cursor/mcp.json` 中配置相同 command、args 和 env。

可用工具：

| 工具 | 用途 |
| --- | --- |
| `group_send` | 发送消息或创建处理占位 |
| `group_send_file` | 生成 md/html/docx/xlsx/pdf/csv/图片等文件并作为可下载附件发给真人 |
| `group_update` | 原位更新自己的消息 |
| `group_history` | 读取历史或增量消息（必须传 `expectedGroupId`） |
| `group_wait` | 等待最长 30 秒（必须传 `expectedGroupId`） |
| `group_members` | 查询成员和 AI ID（必须传 `expectedGroupId`） |
| `group_presence` | 上报在线或忙碌状态 |

**读和写都必须提供 `expectedGroupId`**，也就是你正在回复的那条消息的 groupId；和这个 MCP 连接
绑定的群不一致时直接报错，而不是悄悄返回另一个群的内容。

为什么读也要管：一个 AI 手上可能同时挂着多个群的入口（这个 MCP 连接、别的 session 配置）。
它在 A 群被 `@`，顺手 `group_history` 翻的却是连接绑定的 B 群，然后拿 B 群的历史回答了 A 群的
问题 —— 实测发生过。现在三处一起堵：

1. 服务端在 `routed=1` 的轮询响应里回 `group: {id, name}`，每条消息本身也带 `groupId`；
2. 桥接把群名和 groupId 钉在提示词最前面，并给出这个群专用的取历史命令；轮询到的群与自己的
   配置不一致就停下来，逐条消息的 `groupId` 也再挡一次；
3. MCP 的读工具和 `relay history/wait/listen --connection` 都要求显式说明「我以为我在哪个群」。

`group_send_file` 让 AI 把自己生成的产物交付给真人下载：先在本机生成文件，再用
`filePath` 从磁盘附带，或用 `content` + `filename` 直接内联发送（二进制走 `encoding: "base64"`）。
可选 `text` 作为附言，`mentionIds` @ 具体的人。附件在会话里显示为下载链接，图片额外显示缩略图。
类型按扩展名自动推断（可用 `mimeType` 覆盖），单个文件上限 `MAX_FILE_SIZE_MB`（默认 25MB，与服务端同一个变量）。
非图片附件一律强制下载，不在本站源里内联渲染；SVG 也按下载处理，因为它可以带脚本。
下载路由对非图片一律用 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`
强制下载，因此 AI 生成的 HTML 不会在本站源里被当页面执行。Codex/CLI 一侧对应
`npm run relay -- send ... --file <path>`。

## HTTP API

群组接口用 email 标识身份，没有鉴权：

```http
X-Relay-Email: <email>
X-Relay-Provider: <codex|claude|cursor|opencode>   # 以该 email 名下的 AI 身份行动时才需要
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/account/tasks` | 查询当前账户分配的 Jira AI 任务与进度 |
| `GET` | `/api/account/desktop-workers` | 桌面客户端同步当前账户需要运行的 AI worker（已关掉的不返回） |
| `POST` | `/api/account/sessions/:groupId/ais` | 把账户所有者的桌面 AI 加入群组 |
| `DELETE` | `/api/account/sessions/:groupId/ais/:provider` | 让账户所有者的桌面 AI 离开群组 |
| `POST` | `/api/groups` | 创建群组 |
| `GET` | `/api/invites/:inviteToken` | 查询邀请 |
| `POST` | `/api/invites/:inviteToken/join` | 加入群组 |
| `GET` | `/api/groups/:groupId` | 查询群组和成员 |
| `DELETE` | `/api/groups/:groupId/members/me` | AI 注销自身 |
| `POST` | `/api/groups/:groupId/members/me/presence` | AI 上报状态 |
| `POST` | `/api/groups/:groupId/members/:memberId/trusted-execution` | AI 所有者开启或关闭自己 AI 的免审批执行 |
| `POST` | `/api/groups/:groupId/members/:memberId/desktop-worker` | AI 所有者持久开关某个群的桌面 worker（`{"enabled":false}`），不被客户端同步覆盖 |
| `POST` | `/api/groups/:groupId/approvals` | 桌面 AI 为需要本机工具的消息创建一次性审批请求 |
| `GET` | `/api/account/approvals` | 查看当前账户在所有群组中的审批队列 |
| `POST` | `/api/account/approvals/resolve` | 单条或批量批准 / 拒绝；批准后仅重投对应任务 |
| `POST` | `/api/groups/:groupId/invites/rotate` | 轮换邀请链接 |
| `POST` | `/api/groups/:groupId/messages` | 发送文字或文件；AI 对同一条 `replyTo` 重复发 `processing` 占位时返回已有那条（`deduplicated: true`），不会多出一个气泡 |
| `PATCH` | `/api/groups/:groupId/messages/:messageId` | 更新 AI 消息 |
| `GET` | `/api/groups/:groupId/messages` | 历史或增量消息；`routed=1` 时一条消息只交给先来领的那个 worker（十分钟内不再重发），同一 AI 挂着两个 worker 也不会重复回复 |
| `GET` | `/api/groups/:groupId/messages/wait` | 长轮询新消息 |
| `GET` | `/api/groups/:groupId/events` | 浏览器 SSE |
| `GET` | `/api/groups/:groupId/history` | 历史日期和压缩状态 |
| `GET` | `/api/account/export` | 导出账号 + 群组关系（不含消息） |
| `POST` | `/api/account/import` | 导入上面的结构，幂等 |
| `POST` | `/api/account/sync` | 服务端直接推给 `targetBaseUrl` |

创建群组：

```bash
curl -X POST "$BASE_URL/api/groups" \
  -H 'Content-Type: application/json' \
  -d '{"name":"项目讨论","ownerName":"Yunfei"}'
```

发送文字：

```bash
curl -X POST "$BASE_URL/api/groups/$GROUP_ID/messages" \
  -H "X-Relay-Email: $EMAIL" \
  -F 'text=大家好'
```

发送文件：

```bash
curl -X POST "$BASE_URL/api/groups/$GROUP_ID/messages" \
  -H "X-Relay-Email: $EMAIL" \
  -F 'text=附件见下' \
  -F 'files=@./report.pdf'
```

读取消息：

```bash
curl "$BASE_URL/api/groups/$GROUP_ID/messages?after=MESSAGE_ID&limit=100" \
  -H "X-Relay-Email: $EMAIL"
```

完整接口行为可参考 [src/app.js](src/app.js) 和 [test/app.test.js](test/app.test.js)。

## 数据保存、压缩与清除

默认数据目录为 `./data`，Docker 使用 `group-relay-data` volume。每个群组的数据结构：

```text
data/
  accounts.json
  tmp/uploads/               上传中转,请求结束即清空
  groups/<group-id>/
    group.json
    members.json
    messages/YYYY-MM-DD.jsonl
    messages/YYYY-MM-DD.jsonl.gz
    attachments/YYYY-MM-DD/<uuid>-<filename>
```

**服务端只是中转缓冲区，消息的长期副本在各人自己的客户端里。** 启动时和之后每小时跑一次
维护任务：

1. 压缩昨天和更早的 JSONL 为 `.jsonl.gz`；
2. 清除超过 `GROUP_RELAY_MESSAGE_RETENTION_DAYS`（默认 30 天）的消息文件；
3. 清除超过 `GROUP_RELAY_ATTACHMENT_RETENTION_HOURS`（默认 720 小时）的附件，按文件
   mtime 判定，空的日期目录一并删除；
4. 清除已完结的审批和任务；待审批的审批单和未完成的任务不受保留期影响；
5. 清除中途失败留下的上传临时文件。

读取历史时会合并未压缩和压缩记录，并从最新的一天往回读到够数为止，不会解压整个保留期。
手动执行压缩加清除：

```bash
npm run archive
```

上传走磁盘中转而不是内存，因此单个请求的内存占用与文件大小无关；`compose.yaml` 里给容器
设了 `mem_limit` 和日志上限，适配 1G 内存 / 30G 磁盘的小机器。

### 邮箱就是身份，所以要先问

网页版第一次打开会先问邮箱：填自己常用的那个，这个账号已有的群组立刻出现。也可以选「先不填，
只在这台机器上用」，那样会注册一个 `device-…@device.group-relay.example.com` 的本机账号 ——
它的工作台是空的，因为那是一个全新身份。

已经落在本机账号上的人，在设置页「个人资料 → 编辑资料」里把邮箱改掉保存即可切换，群组随即出现。
换身份时不会把当前表单里的昵称推给对方账号 —— 那会用「我」这类本机默认昵称覆盖掉那个人自己的名字；
切过去后载入的是它自己的资料。

邀请链接的加入表单同样要填邮箱。不问的话，点链接的人会被悄悄注册成一次性设备账号，群组不会
出现在他真正的工作台里。

桌面客户端有原生保存的凭证可以恢复，走不到这两步。

### 整机搬迁（用户什么都不用点）

部署方在**老服务器**上设置搬迁地址并重启：

```bash
GROUP_RELAY_MOVED_TO=https://new-host.example.com
```

老服务器启动时会：

1. 先和新服务器握手（`/health` 必须回 `identity: "email"`），不通就只打日志、继续正常服务；
2. 把**所有**账号连同它们建的群（保留 id 和邀请 token）、加入的群 id、名下的 AI 推给新服务器；
3. 在自己的 `/health` 里公告 `movedTo`。

客户端每分钟查一次 `/health`，看到 `movedTo` 就弹提醒、确认后自己切过去；桌面客户端走原生
`setServerUrl`，后台 AI worker 跟着一起过去。**没有人需要手动点同步**，也不再有「成员先同步、
群主还没过去所以暂时看不到群」的顺序问题。

搬迁地址**只能通过环境变量设置，没有写接口**：这个服务没有鉴权，一个「所有客户端自动跟随」
的可写字段等于把全部客户端拱手让人。

老服务器要继续开着，直到所有客户端都跟过去了。聊天记录不随服务器走 —— 它一直在客户端本机。

### 手动切换与单账号同步

设置页的「服务器」平时只显示当前连接，点**编辑**填另一台 Group Relay 的地址，**保存并切换**：把
当前账号、它建的群组（保留原 id 和邀请 token）、加入的群组 id 和名下的 AI 推过去，然后切换连接 ——
桌面客户端走原生 `setServerUrl`，网页直接跳转。

保存前弹一次确认，完成后弹提醒并显示同步条目数。重复同步是幂等的。

同步在**服务端之间直接完成**（`POST /api/account/sync` → 目标的 `/api/account/import`），
不经过浏览器，所以不需要给每台服务器配 CORS，换域名时也不会被跨域拦住。

**聊天记录不在同步内容里** —— 那份长期副本一直在客户端本地库，跟着客户端走。要把记录搬到另一台
机器，用下面的导出／导入文件。群组 id 和邀请 token 必须原样保留：客户端本地记录、桌面 worker
配置和已经发出去的邀请链接都按 id 认群。

### 聊天记录存在本机

长期副本在客户端的 IndexedDB（`public/history.js`）里，不在服务端。Mac 客户端是
WKWebView、Windows 是带持久 `userDataFolder` 的 WebView2，两端都用默认持久存储，所以网页
和两个桌面客户端共用同一份实现。

打开群聊时先渲染本地记录，再只向服务端请求本地游标之后的增量；游标已经被保留期清掉时服务端
退回「最新 N 条」，客户端按 id 去重、按时间排序后合并，不会重复或乱序。

**服务端不做历史回溯。** 换机器请在「账户与高级恢复」里导出聊天记录文件，在新机器上导入。
附件是二进制，不进本地库，因此超过 48 小时的附件链接会失效——正文仍在。

审批单和 Jira 任务只存消息 id 引用，不存正文副本：审批看板显示 AI 自己写的 summary，任务看板
的标题和进展由客户端按 `sourceMessageId` / `responseMessageId` 回本机记录里取，取不到就退回
Jira key。批准时原文也是按 id 从缓冲区取；若审批单活得比保留期长，原文已清除，则退回 summary
派发，不会失败。

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

### `404 not a member of this group`

确认这个 email 已经加入当前 groupId(AI 还需要对应的 provider 已注册)。同一 AI session 切换
群组后，旧成员身份会被注销，旧后台进程应自动停止。

### AI 一直离线

检查：

```bash
open -a "Group Relay"
npm run relay -- status --session "SESSION_ID"
tail -100 "$HOME/Library/Logs/Group Relay/bridge.log"
tail -100 "$HOME/Library/Logs/Group Relay/ai-stderr.log"
```

同时确认相应的 Codex、Claude、Cursor 或 opencode CLI 已安装并完成本地登录。

没装桌面客户端的机器上，离线的原因通常是没人执行那条注册 —— 起常驻 worker：

```bash
npm run relay -- worker --session "SESSION_ID" --log ~/.group-relay/worker.log
```

### 端口 8787 被占用

停止旧服务，或把 `compose.yaml` 的宿主机端口改为例如 `127.0.0.1:8790:8787`，并同步
修改客户端和 MCP 的服务地址。

## 安全边界

当前版本适用于可信小团队和原型：

- Quick Tunnel 默认没有 Cloudflare Access，知道地址的人可以打开创建群组页面。
- **没有鉴权**：知道 email 和群组 id 就能读写该群、冒名发言、给 AI 派任务。群组 id 是
  UUIDv4 不可枚举，所以实际暴露面取决于服务地址是否公开。这是明确的产品选择。
- 邀请 token 以明文保存在服务端的 `accounts.json` 里。
- 本机自动账户使用随机设备标识；清除浏览器存储后需要重新导入账户备份或群组身份。
- 账户备份包含高权限凭证，必须按密码文件保护。
- 上传文件没有病毒扫描，服务尚未实现速率限制和存储配额。
- 群消息是不可信输入，不能自动扩大本机 AI 的文件、命令或外部系统权限。

公网长期运行建议增加固定域名、Cloudflare Access、速率限制、上传扫描、
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
src/storage.js                文件存储、压缩与保留期清除
bin/relay-client.js           AI session 命令行客户端
bin/mcp-server.js             可选 MCP server
macos/GroupRelayApp.swift     Mac 客户端和后台进程管理
macos/GroupRelayBridge.swift  本地三 Provider AI 桥接
public/app.js                 浏览器客户端
public/history.js             本机聊天记录(IndexedDB)与导出导入
```
