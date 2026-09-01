# ops-ssh-manager — DESIGN（设计溯源与迁移清单）

> 设计权威文档。所有实现决策以本文件为准；它绑定「先调查再实现」：调研结论先沉淀进
> `knowledge/`，再把可迁移设计落到这里的每一条。调研对象仓库核对于 2026-08-19。

## 0. 目标与边界

给 DSH 的 agent 加上「受控 SSH 运维」能力，前提是**agent 永不接触明文的私钥/密码**，只能
通过「代号（备注）」了解与引用机器；对标注为「严格」的机器，任何命令都要**阻塞并等待操作员
批准**（单次 / 本 session 两种粒度）。

- **Phase 1（本文件范围）**：`settings.plugin.item` 配置卡片（连接 / key 管理 / 导入导出 / 每主机审查等级）
  + 方法调用工具 `ssh_exec` / `ssh_list_hosts` + 严格模式强制审批 + 审计。
- **Phase 2（暂缓）**：`ssh_upload/download`、审计回放页、可视化「本 session 批准」白名单、加密导出、
  远程 shell/PTY。

## 1. 调研结论（一句话）

社区有完成度很高的同类（MCP 生态），但无 DSH 原生插件；**自研、复用 DSH 原生
`credentials`/`approval`/`tools-pre-execute`**，把 OneSSH / mcp-ssh-manager 的设计当参照。详见
[`knowledge/domains/ops-ssh-automation/community-landscape-and-migrated-design.md`](../../../knowledge/domains/ops-ssh-automation/community-landscape-and-migrated-design.md)。

## 2. 迁移清单（从哪个方案学了什么）

| 来源 | 迁移内容 | 落到本插件哪里 |
| --- | --- | --- |
| mcp-ssh-manager `src/policy.js` | 三档安全模式 + `READONLY_DENY_REGEX` 破坏性命令正则表（防手滑护栏） | `src/policy.mjs`（审查等级 + denylist） |
| mcp-ssh-manager `src/audit.js` | JSONL 审计格式 + `REDACT_FIELDS` 打码 + 审计失败不中断执行 | `src/audit.mjs` |
| OneSSH `hostmanager/manager.go` | Host 字段、`auth_type=key\|password`、**key 只存 `key_id` 引用**、端口/跳板校验 | `src/schema.mjs`（settings schema） |
| OneSSH `mcpserver/hosts.go` | **TOFU 指纹**（首连固定、变化拒连、显式重置）+ 执行/管理视角分离 | `src/fingerprint.mjs` + 工具拆读/写 |
| OneSSH `cryptox/cryptox.go` | AES-256-GCM 静态加密模式（仅在「加密导出」时用） | Phase 2 导出；存储优先走 `credentials` |
| ssh-mcp-server `execute-command.ts` | 工具契约 `cmdString/directory/connectionName/timeout` + 结构化错误封套 | `src/tool.mjs` |

## 3. 架构与数据流

```
settings.plugin.item 配置卡片 (Client, client.js)
        │  fetch('/api/ops-ssh/*')   ←  webServer.register (Host)
        ▼
Host 插件 (src/index.mjs)
   ├─ settings 服务      → 连接/代号/审查等级/TOFU 指纹（非 secret）
   ├─ credentials 服务   → 私钥 / 密码 明文（只存不回显，仅连接时 resolve）
   ├─ ssh2 连接池        → 按代号建连、执行命令（src/ssh.mjs）
   ├─ 工具 ssh_exec / ssh_list_hosts（src/tool.mjs，defineTool）
   ├─ 强制审批           → approval.request / userQuestions.ask（本 session 白名单自维护）
   └─ 审计               → JSONL + 打码（src/audit.mjs）
```

## 4. 数据模型

**settings（`register` 一个 `ops-ssh` 命名空间）**：

- `hosts: Record<code, HostConfig>`，`HostConfig = { code, alias, host, port, username, authType: 'key'|'password', keyId, review: 'normal'|'strict', jump?, tags, defaultDir? }`
  - `keyId` 是 `credentials` 的引用，**不是私钥本体**。
  - `review: 'strict'` 即「审查登记 = 严格」。
- `fingerprints: Record<code, string>`（TOFU 主机公钥指纹，SHA256 样式）。

**credentials（`set`/`resolve`/`unset`，ref = `ops-ssh:<keyId>` 或 `ops-ssh:pass:<code>`）**：

- 私钥：ref=`OPSSSH_KEY_<keyId>`；密码：ref=`OPSSSH_PASS_<code>`（credentials 契约要求 POSIX 标识符）。
  私钥/密码 value 永不回显、不出 Host。

**session 级状态（内存，插件 fiber 生命周期）**：`sessionApprovals: Map<sessionId, Set<code>>`（本 session 批准）；
`sessionId` 取 `exec.agent.sessionId`，插件重载即失效（本 session 语义按进程内会话算）。

## 5. 工具契约

`ssh_exec`：`{ code: string, command: string, directory?: string, timeout_ms?: number(default 30000) }`。
`ssh_list_hosts`：无参，返回 `[{ code, alias, host, username, review }]`（不含任何凭据）。

## 6. 安全模型（对应需求第 3 条）

1. **隔离**：私钥/密码只进 `credentials`，`ssh_exec` 只收 `code`；返回给模型的只有命令 stdout/stderr/exitCode。
2. **代号**：模型只见 `code`/`alias`（备注）；真实 host/port/user/key 仅在 Host 内查表解析。
3. **严格模式强制审批**（`ssh_exec.execute` 内，顺序）：
   - `code` → 主机配置，若 `review === 'strict'` 且 `code ∉ sessionApprovals[sessionId]` → 发起审批；
   - 经 `userQuestions.ask` 阻塞提问，选项「允许一次 / 本 session 允许 / 拒绝」：`允许一次`→放行单次、
     `本 session 允许`→写入 `sessionApprovals[sessionId]`、`拒绝`→抛错；
   - 提问抛错/无人可答（`DELEGATED_CALLER` 等）一律按拒绝处理（fail-closed）。
4. **审批失败语义**：见 L0 —— `approval.request` 的 `'allowed-once'` 是唯一授予、`unavailable/cancelled`=否决；
   本插件为了「一次 + 本 session」两种粒度用 `userQuestions.ask`（三选项）落地，`approval.request` 与
   `tools.guard` 留作备选/加固（guard 同步先行否决会抢跑 async 审批，故 Phase 1 不挂）。
5. **护栏**：`policy.mjs` 已迁移 `READONLY_DENY_REGEX`（`isDestructive`，含单测），Phase 1 **未接入**主流程，
   供 Phase 2 做 `strict` 主机命令级 allow/deny。
6. **TOFU**：管理页「测试连接」固定主机指纹（`ssh2` `hostHash:'sha256'`），之后变化拒连；**未固定指纹的
   `ssh_exec` 直接拒绝（fail-closed）**，避免 prompt-injection 诱导首连信任。
7. **审计**：每次 `ssh_exec` 与增删操作写 JSONL（code/命令/allowed/exitCode/error），敏感字段打码，审计写失败不中断执行。

## 7. 依赖与打包

- 运行时依赖：`ssh2`（SSH 客户端，纯 JS，无原生编译）。
- peerDependencies：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-tools@0.1.0-rc.7`（`defineTool`），
  以及 client 半部的 `@deepseek-ai/dsh-client-runtime` 等（按需，参考 dsh-web-mobile/dsh-file-upload 的
  `dsh.client.inject`）。
- `package.json`：`type:module`、`main: src/index.mjs`、`exports["./client"]`、`dsh.bundle.patch` + `dsh.client`。
- `cordis.patch.yml`：`insert` 一行插件（`id: ops-ssh-manager`），`config` 下留 `{ dataDir: '', auditLog: '' }`。
  bundle 插件，安装后须重启 DSH（L0 plugin-loading-and-hot-reload）。

## 8. 文件布局（Phase 1）

```
plugins/manual/ops-ssh-manager/
  package.json
  cordis.patch.yml
  src/
    index.mjs        # host 入口：name/inject/apply，挂工具 + 管理页 HTTP 路由 + 审计
    schema.mjs       # HostConfig 校验 + 代号解析（纯逻辑，可单测）
    store.mjs        # roster 持久化 + credentials 读写封装（数据目录/审计路径/ref 构造）
    ssh.mjs          # ssh2 连接建立/执行 + TOFU 指纹 + 公钥派生（参考社区设计）
    policy.mjs       # 审查等级 + READONLY_DENY_REGEX（适配自 mcp-ssh-manager policy.js）
    approve.mjs      # 严格模式审批流（userQuestions.ask 三选项）
    audit.mjs        # JSONL 审计 + 打码（适配自 mcp-ssh-manager audit.js）
    tool.mjs         # defineTool：ssh_exec / ssh_list_hosts
  client.js          # client 半部：window.__ModuleLoader__ + slots.inject('settings.plugin.item', key='ops-ssh-manager')
  scripts/preflight.mjs
  test/*.test.mjs
  README.md          # 三段（改了什么/怎么生效/怎么回滚）
  DESIGN.md          # 本文件
```

## 9. 验证与回滚（README 展开）

- 验证：`node scripts/preflight.mjs`（import 预检 + schema/策略纯函数单测）→ `npm test` → 安装重启后
  在管理页建一台测试机、`ssh_exec` 跑只读命令、把该机标 strict 验证审批弹窗。
- 回滚：`dsh plugin --profile web remove ops-ssh-manager` + 重启（L0 回滚约定）。

## 10. 风险与已知边界

- **ssh2 无原生 shell 语义**：`exec` 每次一个命令（这正是 Phase 1 的取舍）；交互式/长驻进程留 Phase 2。
- **`credentials` 服务的底层落盘/加密由 DSH 提供方决定**（本插件只见抽象 service）；若不满足静默要求，
  Phase 2 再引入自管 AES-256-GCM（OneSSH cryptox 模式）+ 明确主密钥。
- **审批 `request` 要求 open turn**（L0）：审批只发生在“模型正在跑工具调用”的时刻；后台 Job 内调
  `ssh_exec` 的审批语义需在 Phase 2 单独确认（可能走 `userQuestions` 的人机边界限制）。
- 明确不做的：不内置任何沙箱 bypass；不把 `danger-full-access` 写成默认。
## 11. Sudo 提权设计（Phase 1.5，已决策，已实现，已过三轮审查）

> 审查记录：三轮独立代码审查。Round1 报 2C/2H/4M/5L——最关键：ssh2 exec channel
> 无 'ready' 事件（密码写入回调永不执行，已改为 exec 回调内立即 write+end）；认证/执行信号混用
> （已改为内层 sh 执行标记方案，NOPASSWD 下命令 rc=1 不再误判重跑）。Round2 复核修复并新抓 2 阻断
> （classifySudoProbe 残留、ssh_list_hosts schema 缺 sudo 字段）。Round3 全项 VERIFIED-FIXED，结论可合入。
> 隔离环境验证：NOPASSWD elevate → root；rc=1 命令 → executed rc=1；无密码主机 → SUDO_PASSWORD_REQUIRED。

> 溯源：2026-08 的设计讨论、独立复核与多种 sudo 配置的隔离验证。
> 操作员已拍板：裸 sudo token 守卫 fail-closed；Phase 1.5 不做 `sudo -u`；**存量主机不做向前
> 兼容**——roster 直接升 v2、一次性迁移补默认 `sudo: 'auto'`（唯一允许的兜底默认值）；
> 设置面按「两个框」极简形态（主授权不变 + sudo 开关/密码，无复用勾选）。

### 11.1 目标与总路线

覆盖两类 sudo 场景：sudoers NOPASSWD（免密）与需要密码的 sudo；**sudo 密码明文只允许存在于
credentials 存储 + 插件进程内存（执行瞬间）**，绝不进模型上下文、命令串、审计、roster、错误信息。
总路线：**两阶段自适应协议（sudo -n 探测 → 需要时 sudo -S stdin 注入）+ 显式 elevate 参数 +
提权独立审批**；PTY/expect 方案否决（复杂度高、密码过 pty 缓冲，B 已覆盖全部场景）；
受限 NOPASSWD drop-in 是长期正道（Phase 2 管理页给指引），密码 sudo 是兜底。

### 11.2 两阶段注入协议（每条提权命令，同一 SSH 连接两个 exec channel）

```
标记 MARKER = __OPSSSH_EXEC__（由内层 sh 用两个半串拼接，外层命令文本不含完整字面量，
防 sudo 拒绝信息引用命令时伪造标记）：

阶段1: conn.exec(`sudo -n /bin/sh -c 'echo <标记>&2; <command>'`)   // -n 绝不挂住
  ├─ stderr 含标记 → sudo 放行、命令已执行：close code = 命令自身 rc（含 rc=1，
  │   不再误判为「要密码」而重跑非幂等命令——Codex Round1 第 2 项必查的修复）
  ├─ 无标记 rc=127（sudo: not found）→ SUDO_NOT_FOUND，不进阶段 2
  └─ 无标记其他 rc≠0（命令未执行，可安全重跑）→ 有存密码则进阶段 2，无存密码报
      SUDO_PASSWORD_REQUIRED
阶段2: conn.exec(`sudo -S -p '' /bin/sh -c 'echo <标记>&2; <command>'`)
  └─ exec 回调内立即 stream.write(password + '\n') + end()（ssh2 exec channel 无
      'ready' 事件，channel 会缓冲 stdin 直到 sudo 读取；单次尝试不重试）
      无标记 → sudo 拒绝（按文案尽力分类，绝不报成功）
```

- **分支判定以 exit code 为主，stderr 文案只做辅助提示**：实测同一「需要密码」场景的 stderr 随远端
  locale 变化（`a password is required` / `需要密码` / `interactive authentication is required` 三种
  都在实机上出现过），按文案匹配分支不可靠。`sudo -n` 需密码时先拒绝、不执行命令（这一性质与
  locale 无关，是两阶段安全性的根据）。

- **为什么不能盲注入**：NOPASSWD（或远端已有全局 timestamp）时 sudo 不读 stdin，写入的密码行会
  成为命令自身的 stdin——`sudo cat/tee/wc` 等会把密码当数据处理甚至打进 stdout 回流上下文/审计。
  `sudo -n` 需密码时**先拒绝、不执行命令**，故阶段 2 重跑无非幂等风险；阶段 2 里 sudo 必然先消费
  密码行，命令拿到 EOF，密码不可能变成命令的数据。
- **sudoMode 声明（passwordless/password）只影响预检提示，不改变执行协议**——仍先 -n 探测，
  防配置错误导致盲注入泄漏。不加 `-k`（不破坏远端票据状态）。默认 `tty_tickets` 下每次 exec 都是
  新 session，`sudo -v` 会话缓存不可靠，不做。
- 已知限制：阶段 2 命令本体不能读 stdin（拿到 EOF）；需要读 stdin 的命令由模型用重定向改写。

### 11.3 模型侧契约

- `ssh_exec` 新增可选参数 `elevate: boolean`（Phase 1.5 只支持提权到 root，不做 `-u`）。
- **token 守卫（fail-closed）**：raw command 按词边界匹配 `\bsudo\b` / `\bsu\b`（常量表可扩展
  doas 等）而未设 `elevate: true` → 拒绝（错误码 `SUDO_TOKEN_WITHOUT_ELEVATE`），错误信息引导：
  确需提权显式声明；仅引用词面（如 `grep sudo /var/log/auth.log`）就改写（如 `sud[o]`）。
  理由：堵死「NOPASSWD 主机上裸 sudo 静默成功、绕过提权审批」的洞；误报代价用 fail-closed 换安全。
- `elevate: true` 且 `sudoMode: 'none'` → 拒绝（`ELEVATION_DISABLED`）。
- `ssh_list_hosts` 每台增加 `sudo: 'none'|'auto'|'password'` 只读字段（配置声明，模型可预判；
  免密与否以实际执行为准，插件不缓存探测结果——sudoers 随时可被管理员改动）。

### 11.4 数据模型与秘密（「两个框」形态，已决策）

设置面只有两块，与「两条授权链」一一对应：

```
框① 主授权（现有，不动）： ( ● 密钥 ○ 密码 ) + 密钥/密码输入      → 链 A（传输层）
框② sudo：                [ ✓ 启用提权 ] + sudo 密码框（可留空）  → 链 B（提权层）
```

- roster v2 字段：`sudo: 'none' | 'auto' | 'password'`（就三个值，扁平枚举，不再是嵌套对象）：
  - 开关关 → `'none'`：模型 elevate 一律拒（`ELEVATION_DISABLED`；未装 sudo 的机器如路由器用这档）；
  - 开关开 + 密码留空 → `'auto'`：执行时两阶段自适应，免密直接跑、要密码没存则明确报错；
  - 开关开 + 密码填了 → `'password'`：密码存 credentials，执行时两阶段注入。
- 「复用主授权密码」不做勾选项（操作员决策：砍掉复杂度）——想复用就把同一密码粘进框②。
- credentials 新 ref：`OPSSSH_SUDO_<hex(code)>`（沿用 hex 防碰撞约定）；sudo 密码与主授权密码
  互相独立，key 登录的主机同样可以有 sudo 密码。
- **迁移（无向前兼容）**：roster `version 1 → 2`，v2 校验要求每台主机必须有 `sudo` 字段；遇 v1
  文件大声报错（运行时零兼容代码）。配套一次性迁移脚本：读现存 roster → 全部主机补默认
  `'auto'`（唯一允许的兜底默认值）→ 写回 v2。
- 管理页（Phase 2 完整化）：主机卡片「提权」区即框② + 「测试提权」按钮（`sudo -S -v` 验证密码）。

### 11.5 审批语义（与主机 review 相互独立）

`sessionApprovals` 拆双键：exec 批准与 elevate 批准互不覆盖。「本 session 允许了这台主机」不包含
提权资格。矩阵：normal+elevate 触发提权审批（审批升级而非放行）；strict+elevate 两项都缺时合并为
一次审批、文案标注「将提权」，批准按各自粒度分别记键。审批不可达一律拒绝（fail-closed）。

### 11.6 错误分类（密码零泄漏）

分支判定以 exit code 为主，stderr 文案（locale 相关，见 §11.2）只用于把错误细化成给模型看的提示：

| 码 | 判定 | 给模型的提示 |
| --- | --- | --- |
| ELEVATION_DISABLED | `sudo: 'none'` | 引导去管理页启用 |
| SUDO_TOKEN_WITHOUT_ELEVATE | 守卫命中 | 显式 elevate 或改写词面 |
| SUDO_NOT_FOUND | 阶段 1 rc=127 | 该机没装 sudo |
| SUDO_PASSWORD_REQUIRED | 阶段 1 rc≠0 且无存储密码 | 提示操作员登记 sudo 密码 |
| SUDO_AUTH_FAILED | "incorrect password attempt"/"no password was provided" | 认证失败，单次不重试（防 fail2ban） |
| SUDO_POLICY_DENIED | "is not allowed to execute" | sudoers 拒绝该命令 |
| SUDO_FAILED | 其他 | 附干净 stderr |

### 11.7 审计与威胁缓解

- 审计记录增加：`elevated`、`elevatePath: 'passwordless'|'password'`、提权审批 verdict、错误码；
  密码无任何落盘路径（只走 stdin、sudo 不回显、`-p ''` 无 prompt 落 stderr）。
- 威胁→缓解：裸 sudo 绕过审批→token 守卫；盲注入泄漏→两阶段协议；prompt injection 诱导 elevate→
  normal 主机也升审批；fail2ban/锁定→单次尝试绝不重试。

### 11.8 实施切分

- **Phase 1.5**：elevate 参数 + token 守卫；两阶段协议（exit code 驱动）；roster v2（`sudo` 三值枚举）
  + 一次性迁移（补 `'auto'`）+ `OPSSSH_SUDO_*`；审批双键；错误分类（含 `SUDO_NOT_FOUND`）；审计字段；
  纯逻辑单测（守卫正则/协议状态机/错误分类/v2 校验）。验收：NOPASSWD 机器免密跑通、
  密码机器注入跑通且密码全链路不可见、裸 sudo 被拒、v1 roster 被迁移且运行时对缺字段 fail loud。
- **Phase 2**：`sudo -u` 白名单（逐主机配置、模型传值校验不过即拒）；管理页提权区 + 测试提权 +
  NOPASSWD drop-in 生成指引；`ssh_list_hosts` 能力信号；连接复用让两阶段共享连接。
