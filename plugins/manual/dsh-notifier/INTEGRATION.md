# dsh-notifier（手动维护版：vendor 源码 + 定制）

> 一句话：给 DSH 装上「手机遥控」——会话事件/审批/**提问(ask)** 主动推到手机，且能从飞书
> 反向审批、对话、发命令。本目录是 **vendor 的 dsh-notifier@0.7.3 源码 + 我们的定制**，
> source of truth 在本仓库（`plugins/manual/`）。

## 改了什么（相对上游 0.7.3）

| 改动 | 文件 | 说明 |
|---|---|---|
| **ask 桥接（核心新增）** | `src/ask-bridge.mjs`（新增）+ `src/index.mjs` L10/L314 | 包装 `ctx.userQuestions.ask`，提问时推「🔔 需要你回答」到出站渠道（human-call 提醒） |
| registerApp API 兼容修复 | `src/inbound/_feishu-register.mjs` | `onQrCode`→`onQRCodeReady({url})`、`addons.resources`→`scopes/events/callbacks`、报错是 `{code,description}` 对象 |
| 扫码权限补全 | `src/inbound/_feishu-register.mjs` | scopes 补 5 个读权限（原只申请「发消息」，漏了读 → 收不到消息） |
| 临时排障日志 | `src/inbound/feishu-bot.mjs` | `handleMessage` 写 `/tmp/feishu-debug.log`（排障用，可删） |

## 怎么生效

```bash
# 1. 装依赖（link: 包不会自动装它的 optional deps，node-sdk 等要单独装进本目录）
cd plugins/manual/dsh-notifier && pnpm install
# 2. 用 link: 协议挂进 web profile（改源码即时生效，无需重装）
npx -y @deepseek-ai/dsh plugin --profile web add "link:$PWD/plugins/manual/dsh-notifier"
# 3. 重启
bash plugins/manual/web-remote-access/daemon/restart.sh
```

## 怎么回滚

```bash
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-notifier
npx -y @deepseek-ai/dsh plugin --profile web add dsh-notifier@0.7.3   # 回上游 npm 版
bash plugins/manual/web-remote-access/daemon/restart.sh
```

---

# 附：飞书入站集成经验（原 community 配方迁入）

## 何时读本文件

- 要**新装** dsh-notifier、或**重打飞书入站**（换机/换 profile/换飞书企业）时读。
- 要**排障**飞书入站（收不到消息/审批卡片不发/长连接掉线）时读。
- 只看插件全貌（27 渠道、分级路由等）→ 读插件自带 README（在
  `~/.dsh/profiles/web/node_modules/dsh-notifier/README.md`）。

## 1. 安装（版本写死）

```bash
npx -y @deepseek-ai/dsh plugin --profile web add dsh-notifier@0.7.3
```

> 版本必须写死（`@0.7.3` 而非 `@latest`）：pnpm 会扣下 24h 内新版本。装完自动进
> `package.json` 的 `dependencies` + `dsh.profile.bundles`。

## 2. 落盘位置（三处，都要知道）

| 项 | 路径 |
|---|---|
| 插件本体 | `~/.dsh/profiles/web/node_modules/dsh-notifier/` |
| 配置（用户层补丁） | `~/.dsh/profiles/web/cordis.patch.yml` |
| 扫码凭证 + 身份绑定 + 审批态 | `~/.dsh/dsh-notifier/state.json`（0600） |

## 3. 飞书入站配置

`cordis.patch.yml` 追加（凭证走 state.json，YAML 不写明文密钥）：

```yaml
- id: dsh-notifier
  config:
    channels:                                  # 出站通知（turn/end、approval/asked、agent/error）
      - type: feishu
        webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/<群机器人token>"
    inbound:                                   # 入站（远程审批 + 远程对话）
      allowUsers:
        - "ou_你的open_id"   # 扫码者 open_id，扫码 CLI 会打印
      feishu: {}              # 空对象 = 回退 state.json 里的 feishu:account
    approval:
      mode: answer            # 远程审批（否则只旁观，不推卡片）
      timeoutMs: 2147483647   # 可选：近似无限（Node setTimeout 上限 ≈24.8 天）；默认 120000（2 分钟）
```

> 若不想依赖 state.json，也可显式写 `inbound.feishu.appId/appSecret`（支持
> `${ENV:NAME}` 环境变量引用；0.7.3 已修入站 `${ENV:}` 不解析的 bug）。
>
> 出站 `channels`（群机器人 webhook）与入站 `inbound`（自建应用 bot）是**两个飞书角色**：
> webhook 只发文本通知、无按钮；bot 私聊才发可交互审批卡片 + 收命令/对话。

## 4. 扫码建应用（官方一键创建，需先打补丁）

```bash
node ~/.dsh/profiles/web/node_modules/dsh-notifier/scripts/channel-login.mjs feishu
```

扫码确认后自动创建飞书自建应用，`appId`/`appSecret` 原子落盘 state.json
（`feishu:account`），并打印扫码者 `openId`。

**扫码只做了一半**，剩下必须手动去 open.feishu.cn 后台补：

1. **事件订阅 → 订阅方式选「使用长连接接收事件」**（否则消息不会推到 WebSocket）。
2. **应用能力 → 机器人** 确认开启。
3. **补开 5 个「读消息」权限**（扫码只申请了「发消息」，漏了读 → 收不到消息，本次根因）：

   | 权限点 |
   |---|
   | `im:message.p2p_msg:readonly` |
   | `im:message.group_at_msg:readonly` |
   | `im:message.group_msg` |
   | `im:message.group_at_msg.include_bot:readonly` |
   | `im:message.group_msg.include_bot:read` |

4. **创建版本并发布**（发布后机器人才能真正收发）。

## 5. 验证

在飞书里搜到机器人、私聊它，依次发：

```
/help      # 回命令集
/whoami    # 回绑定身份（owner）
/status    # 回绑定与 agent 状态
/pair xxxx # 绑定（已迁移绑定则无需）
hello      # 纯文本 = 对话，会进 agent 会话
```

## 6. 回滚 / 卸载

```bash
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-notifier
# 再从 cordis.patch.yml 删掉 - id: dsh-notifier 整段，重启 DSH
rm -f ~/.dsh/dsh-notifier/state.json   # 连凭证/绑定一起清
```

## 7. 集成踩坑记录（带证据）

### 7.1 `channel-login.mjs feishu` 与 node-sdk 1.73.0 不兼容（必修补丁）

插件 `src/inbound/_feishu-register.mjs` 用了旧 SDK API，直接跑必炸
`addons.resources is not allowed; allowed keys: preset, scopes, events, callbacks`。
三处错位（证据：`@larksuiteoapi/node-sdk@1.73.0/README.zh.md` L715-830 与
`es/index.js` 的 `normalizeAddons` L102939-102990）：

| 插件旧写法 | SDK 1.73.0 实际 |
|---|---|
| `onQrCode(url)` | `onQRCodeReady({url, expireIn})` |
| `addons.resources.im.*` | `addons.{preset,scopes,events,callbacks}` |
| 失败 `outcome.status` | reject 普通对象 `{code, description}`（不是 Error） |
| 成功 `outcome.client_id/secret` | `{client_id, client_secret, user_info}`（无 status） |

已在本机安装副本打好补丁（含 §7.4 的读权限），**插件升级会丢，需重打**。

### 7.2 `qrcode-terminal` 的 ASCII 二维码画不出来

插件 `channel-login.mjs` 调 `import('qrcode-terminal').toString(...)`，但该包（CJS）
导出的是 `default.generate`，回调是 `(output)` 而非 `(err,text)`——终端二维码永远空白，
只剩链接。证据：`qrcode-terminal/lib/main.js` 的 `module.exports`。
处理：用 Python `qrcode` 把链接另生成 PNG（`/tmp/feishu-qr.png`）扫码。

### 7.3 `dsh plugin add` 报 missing peer `@deepseek-ai/cordis@^4.0.1`

无害。插件声明了 cordis peer，但宿主 DSH 已提供 `@deepseek-ai/cordis@4.0.1`
（npx 缓存目录），运行时由宿主注入 `ctx`，插件源码不直接 import cordis。

### 7.4 扫码只申请了「发消息」，漏了「读消息」→ 收不到任何消息（本次根因）

registerApp 的 `addons.scopes` 至少要同时给**发 + 读**：`im:message:send_as_bot`（发）
+ §4 那 5 个读权限。只给 `send_as_bot` 时，长连接能建立（日志显示「已建立」），但
`im.message.receive_v1` 事件一条都收不到。现象特征：飞书发 `/help` 毫无反应，但插件
日志显示 WS 已连接——本质是「事件订阅了、读权限没开」。

### 7.5 插件 `console.error` 日志进不了 `dsh-web.log`（宿主日志拦截）

重启后 `dsh-web.log` 里看不到插件的 `warn`/启动日志（老进程能看到、新进程看不到，
疑似宿主 boot 后接管了 console）。排障时给 `feishu-bot.mjs` 的 `handleMessage` 加
`appendFileSync('/tmp/feishu-debug.log', ...)` 直接写文件绕过，才能确认事件到底有没有到插件。

### 7.6 飞书 WebSocket 长连接偶发抖动（网络/DNS 瞬时问题，自动重连恢复）

日志偶见 `timeout of 15000ms exceeded` + `getaddrinfo ENOTFOUND open.feishu.cn`。
本机 `dig open.feishu.cn` 正常（走 223.6.6.6）、curl 也通——属 Feishu CDN 节点 + DNS
瞬时抖动，SDK 会重连到另一节点恢复（实测连到 103.71.68.248 恢复）。不影响使用，但
意味着入站并非 100% 稳定，长任务期间掉线靠 SDK 重连兜底。

### 7.7 多 agent 路由歧义：消息被路由到「最近活跃」的历史 session

未 `/bind` 时，通道默认路由走「最近活跃」session（多活跃会话按活跃度兜底）。多 session
并存时，飞书发的消息可能落到一个你不认识的历史 session，而不是当前想操作的（实测：发
「发我审批卡片试试」被路由到历史 session）。证据：`src/inbound/conversation.mjs` 的投递
语义（followup/inject/steer）+ `src/routing/agent-router.mjs`。

处理（都在飞书私聊机器人发）：

- `/route` —— 看当前双向解析（来源 → 目标 session、歧义候选）
- `/agent use <workspace|sid 前缀>` —— 本对话切到指定会话
- `/bind <sessionId>` —— 精确绑定到某个 sid
- `/agent back` / `/unbind` —— 回通道默认

## 8. 已知未验证项 / 注意

- **审批卡片**：需真实触发一次「需要批准」的动作才会推卡片（`approval/request` 事件）。
  发一句「发我审批卡片试试」只是**对话文本**（followup 进会话），不会触发审批；且本机
  `permission.defaultPreset: danger-full-access` 下多数动作不触发审批。尚未端到端验证
  「审批卡片 → 飞书点按钮 → 批准回填」链路。
- **ask 提问（`ask_user_question`）不桥接飞书**：0.7.3 未支持（CHANGELOG 列为 0.8.0 规划），
  提问只出现在 Web 页面，飞书收不到、也无法远程回答。0.8.0 计划新增 `ask_user` 工具
  （推选项卡片/编号回复，复用审批桥接栈）。
- **完成通知已配好**：出站 webhook 已配，`turn/end`/`approval/asked`/`agent/error` 会推
  文本到飞书群（无按钮）。若群机器人开了「签名校验」，还需在 `channels[].feishu` 补 `secret`。

## 9. 维护提醒

- 插件升级会覆盖 `node_modules` 里的补丁，升级后需重打 §7.1 补丁。
- `state.json` 含 appSecret 明文（0600），备份/同步时注意别外泄。
