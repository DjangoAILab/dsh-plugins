# community-landscape-and-migrated-design — 社区 SSH/Agent 方案盘点与可迁移设计

> 本文是 `ops-ssh-manager` 插件「先调查再实现」的产物：先盘点社区里是否已有完整方案，再逐条明确
> 值得迁移的设计与逻辑（带源码位置证据）。调研对象仓库与本文件均核对于 2026-08-19。

## 一、是否已有完整方案

社区（MCP 生态，非 DSH）已有三个梯度的方案，但没有一个是 DSH 原生插件：

| 方案 | 定位 | 一句话 |
| --- | --- | --- |
| [OneSSH](https://github.com/Lynricsy/OneSSH) | 集中式 SSH 网关（Go 单二进制） | 凭据不出网关 + 令牌授权 + 全量审计 + Web 管理台，最接近完整愿景 |
| [mcp-ssh-manager](https://github.com/bvisible/mcp-ssh-manager) | MCP SSH 服务器 + 每服务器安全模式 | 安全模式设计值得借鉴；本仓库适配了其策略正则与审计打码代码并保留 MIT 声明 |
| [ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) | MCP 官方收录的 SSH 参考实现 | 「凭据隔离 + 黑白名单 + exec/shell 双传输」的最小可运作基线 |

结论：**DSH 内没有现成完整插件**；要把这些 MCP 方案的能力「落到 DSH 原生」上自研，而不是直接引入网关或
MCP server 进程。

## 二、关键共识（为什么安全要做在「server 侧第二道」）

1. **客户端 `autoApprove` 是「工具级、全有或全无」**，挡不住 `rm -rf /`。`mcp-ssh-manager`
   `docs/SECURITY_MODES.md` 明确写了这一点，所以它在 **MCP server 内部**加了独立于客户端授权的第二道
   过滤器（"defense-in-depth against accidents and prompt-injection"），且**不是 kernel 沙箱**。
2. **凭据隔离是标配**：OneSSH「Agent 永远拿不到明文」，ssh-mcp-server「凭据完全本地管理不暴露给 AI」。
3. **每命令审计 + 敏感字段打码**：`audit.js` 把 password/token/apikey 等归一化为 `***` 再落盘。
4. **TOFU 指纹**：首次连接固定主机公钥指纹，之后指纹变化直接拒连（防中间人），重装时才显式重置。
5. **MCP 规范 2025-11-25 新增 `elicitation`**（服务器主动请求结构化用户输入）= 社区「工具阻塞并问用户」
   的标准原语；Claude Code 侧则是 `allow/ask/deny` 权限模型 + hooks 拦破坏性命令。

## 三、可迁移设计清单（带证据）

### 3.1 安全模式与破坏性命令正则 —— `mcp-ssh-manager/src/policy.js`

- 三档：`unrestricted`（默认，早退）/ `readonly`（拦变更类工具 + 内置破坏性 denylist）/ `restricted`
  （`ALLOW_PATTERNS` + `DENY_PATTERNS` 正则，**DENY 优先，无 ALLOW 即 fail-closed**）。
- `evaluatePolicy(serverConfig, toolName, command) → { allowed, reason }` 是干净可复用的判定契约。
- **`READONLY_DENY_REGEX`（第 59–93 行）是一张可在保留 MIT 声明后适配的破坏性命令正则表**：`rm/rmdir/mv/dd/mkfs/chmod/
  chown/truncate/tee/sudo/su/kill/pkill/killall/shutdown/reboot/halt/poweroff`；`systemctl|service|docker`
  的 restart/stop/rm 等；`apt/yum/dnf/pip/npm/git` 的 install/remove/reset--hard/push--force；
  `>\s*/`、`>>\s*/`（非 /tmp、非 /dev/null 的重定向）；`| sh`、`| bash`、`curl|sh`、`wget|sh`。
- 注意其定位：**不是安全边界，是防手滑/防注入的护栏**（README 原文反复强调——这恰好对应我们要把它当
  `guard` 否决层的用途）。

### 3.2 审计与打码 —— `mcp-ssh-manager/src/audit.js`

- JSONL 一行一条：`{ts, server, tool, args, allowed, reason?, exitCode?, success?, error?}`。
- `REDACT_FIELDS` = password/passphrase/sudopassword/sudo_password/token/secret/apikey/api_key →
  `***`，递归 `sanitize`。审计写失败**只告警、绝不中断工具执行**。

### 3.3 主机与认证模型 —— `OneSSH/internal/hostmanager/manager.go`

- Host 输入字段：`name/addr/port(0=22)/username/auth_type(key|password)/key_id/password/jump_host/tags`。
  密码为「只写不可读、审计固定脱敏」；`key` 认证只存 `key_id` **引用**，绝不内联密钥材料。
- 校验：name/addr/username 非空；port ∈ [1,65535]；跳板链 ≤ 5 级、不得成环。
- 密码 μin 态加密：`auth_type=password` 时 `m.box.Seal(plain)` 后存 `PasswordEnc`（见 3.5）。

### 3.4 TOFU + 权限分离 —— `OneSSH/internal/mcpserver/hosts.go`

- `host_test` 描述原文「首次连接会记录并固定该主机的公钥指纹（TOFU），之后指纹变化导致连接被拒」；
  `host_reset_fingerprint` 仅用于「确认来自重装/换主机密钥」的可信变更。
- 工具分两类：`hosts_list`（**执行视角**，当前令牌能碰的主机）vs `hosts_manage_list`（**管理视角**，
  需 `manage_hosts` 权限）。「执行权限」与「配置管理权限」分离的原则要保留。
- MCP 工具注解 `ReadOnlyHint/DestructiveHint/IdempotentHint/OpenWorldHint` 可对应到 DSH 工具的
  description/isConcurrencySafe 表述。

### 3.5 静态加密 —— `OneSSH/internal/cryptox/cryptox.go`

- AES-256-GCM，32 字节主密钥，nonce 随机生成并**前缀于密文**（`Seal` = nonce ‖ ciphertext）。
- 主密钥丢失即不可恢复（OneSSH README 的 WARNING）。DSH 侧若用原生 `credentials` 服务存私钥，则不必
  自造 KMS；只在做「加密导出」时可能需要这份 AES-GCM 模式。

### 3.6 工具契约 —— `ssh-mcp-server/src/tools/execute-command.ts`

- 入参 `{ cmdString, directory?(cwd), connectionName?(默认 default), timeout?(ms, 默认 30000) }`。
- 出错返回结构化封套 `{code, message, retriable}` + `isError:true`，不把堆栈直抛给模型。

## 四、映射到 DSH 原生（实现基座）

- 密钥/密码隔离 → L0 的 `credentials` 服务（`set` 存、执行时 `resolve`、`describe` 不回显）。
- 连接/代号/审查等级（非 secret）→ L0 的 `settings` 服务（`register<T>(ns, schema)` 持久化）。
- 强制审批 → L0 的 `approval.request`（单次 `'allowed-once'`）+ 自维护**本 session 代号白名单**
  （"本 session 批准"）；否决层可选 `tools.guard` / `tools/pre-execute`。
- 内联提问 UI → L0 的 `userQuestions.ask`。
- 命令过滤护栏 → 适配 §3.1 的 `READONLY_DENY_REGEX`，保留来源和许可证。
- 审计 + 打码 → 适配 §3.2 的 JSONL + `REDACT_FIELDS`，保留来源和许可证；落点优先 session 日志或插件自有审计文件。

## 五、Phase 1 设计要点（`ops-ssh-manager`）

- **形态**：`plugins/manual/` 下的 npm 包（非临时动态插件，因为连接/密钥要跨会话持久化）。
- **Host**：`ssh2` 连接池；`credentials` 存私钥、`settings` 存连接/代号/审查等级；注册工具
  `ssh_exec` / `ssh_list_hosts`；`ssh_exec` 内部按代号查表 → 若「严格」且本 session 未批 → `approval.request`
  / `userQuestions.ask`（允许一次 / 本 session 允许 / 拒绝）→ 同意才建连执行；审计 JSONL + 打码。
- **Client**：`settings.section` 管理页（连接、key 管理/导入导出、每主机审查等级三块），经 `harness.handle`
  / `host.call` 走 Host RPC。
- **Phase 2（暂缓）**：upload/download、审计回放页、「本 session 批准」可视化白名单、加密导出。
