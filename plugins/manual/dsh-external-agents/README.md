# dsh-external-agents —— 把 Codex / Claude Code 当 DSH 子 agent 调（package v0.5.1）

> 一句话：把外部 CLI Agent（Codex、Claude Code）注册成 `dsh-subagent` 的**出进程 provider**，
> 以**自写单工具**暴露给模型。`codex` 升级为「一个工具 + `model` 参数」，内部按别名路由到
> route provider；异步走 DSH 原生后台 Job（完成自动 notice 唤醒父会话；`job_output(wait:true, timeout_ms)`
> 带上限阻塞等待、完成即提前返回；`job_kill` 取消），不重造。
> v2 已彻底移除对 `@deepseek-ai/dsh-tool-subagent` 的依赖。设计权威见 [`DESIGN.md`](DESIGN.md)。

## 何时读本文件

- 要安装 / 升级 / 回滚、加/改模型或 provider、换沙箱 / 切模型、排查工具没出现 / CLI 找不到时。
- 判断这个活该派给 codex 还是 claude 时（见「边界：什么时候用 Codex / Claude」）。

## 1. 改了什么（原理与边界）

全部落在 DSH 官方公开缝隙上（L0 [tool-async-and-callback-contract](../../../knowledge/foundations/tool-async-and-callback-contract.md)）：

1. **注册出进程 provider**：`ctx.subagents.registerProvider(createCliProvider(...))`，一个路由一个 provider
   （名 `external:codex:<别名>` / `external:claude`）。`start(request)` 用 `ctx.subprocess.spawn` 起外部 CLI、
   prompt 走 stdin、`exit 0→completed / 非0→error / abort→aborted`，取消 = `request.signal → terminate()` 树级升级。
2. **自写单工具**（`src/tool.mjs`，替代三方 `dsh-tool-subagent`）：
   - `codex`：参数 `{ description?, model?, prompt, run_in_background }`；`model` 只收**别名**
     （映射到 route，不收 baseUrl/key/provider/argv，防注入）。description 动态列举可用模型。
   - `codex_models`：副带查询工具（`isConcurrencySafe`），返回 别名→provider→实际模型，config 变化时兜底刷新。
   - `claude_code`：自写单 provider 工具（Anthropic 协议）。
   - 同步 = `await ctx.subagents.start(...).result → dispose()`；异步 = `ctx.jobs.start`（原生后台 Job）。
3. **配置解析**（`src/route.mjs`，纯函数可单测）：`providers`/`models`/`defaultModel` 全由插件配置驱动，
   不读 DSH 主模型选择器；配置错误在 apply **fail loud**。

**边界（不变）**：

- 出进程 provider 只能 one-shot：`outputSchema`/`maxDepth`/`toolFilter`/`persona` 父侧强制特性不提供。
- 输出只有进程 stdout/stderr 一次性文本，无流式、无结构化 schema。
- 异步 = 后台 Job：完成时 `dsh-tool-jobs` 自动向父会话投递 completion notice（idle 父会话 wakeup
  唤醒，预算 `maxConsecutiveWakes` 默认 3、用户消息重置）；`job_output(wait:true, timeout_ms)` 是
  「带最大等待时长的阻塞等待」，完成即提前返回、到时返回 `[status: running]` 且 job 存活。推送式
  流式回call（边跑边推增量）只属于进程内 continuable 子 agent，外部进程做不到；但「完成即唤醒」是有的。

## 2. 怎么生效

### 2.1 安装 + 冷启动预检（bundle 插件，必须重启 DSH）

```
# 生产 profile 必须 file:（机制见 L0 profile-plugin-dependency-resolution.md），勿用 link:
node "$HOME/.dsh/runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile <profile> add "file:$PWD/plugins/manual/dsh-external-agents"

# 在安装副本中验证宿主 peer import 和随包测试；源码目录本身不安装这些 peer。
cd "$HOME/.dsh/profiles/web/node_modules/dsh-external-agents"
node scripts/preflight.mjs && npm test
```

> bundle 装完要**重启 DSH** 才加载（L0 [plugin-loading-and-hot-reload](../../../knowledge/foundations/plugin-loading-and-hot-reload.md)）。
> 重启由用户或外部守护进程执行，别让承载当前会话的进程自我终止。

### 2.2 配置（v2 schema，见 `cordis.patch.yml`）

```yaml
codex:
  enabled: true
  command: codex
  args: ['exec', '--skip-git-repo-check', '-s', 'workspace-write']   # normal 基线档（刻意不内置 bypass）
  defaultModel: fast
  providers:
    builtin: { type: builtin }            # codex 内置 OpenAI（走 codex 自身 auth）
    gateway:                              # OpenAI-compatible provider
      baseUrl: 'https://api.example.com/v1'
      wireApi: responses
      envKey: THIRD_PARTY_API_KEY
      apiKey: '${ENV:THIRD_PARTY_API_KEY}'
      models: ['provider-model-fast', 'provider-model-pro']
  models:                                 # 模型可见别名 -> { provider, model }
    fast:          { provider: gateway, model: provider-model-fast }
    pro:           { provider: gateway, model: provider-model-pro }
    gpt-5.6-sol:   { provider: builtin, model: gpt-5.6-sol }
    gpt-5.6-terra: { provider: builtin, model: gpt-5.6-terra }
claude:
  enabled: true
  command: claude
  args: ['--print', '--output-format', 'text']
  # model: 'provider-model-fast'           # 置空=默认；置串=--model
  # provider: gateway                     # 自定义 Anthropic 端点（ANTHROPIC_BASE_URL/AUTH_TOKEN）
```

每 agent 可选 `cwd` / `env`；claude 默认走 `scrubbedParentEnv()` 时靠 `~/.claude/settings.json` 自加载 env，
或在此显式转发。全局 `graceMs`（取消 SIGTERM→SIGKILL 宽限）与 `maxOutputBytes`（缓冲上限）同 v1。

### 2.3 权限档位（v2.2 `argsProfiles`：yolo / 批限怎么开）

**背景卡点（2026-08-28 实测复现）**：headless 一次性运行没有人工审批面——
`codex exec` 天生 `approval: never`（只剩沙箱边界，写 `~/.dsh` 必 EPERM）；
`claude -p` 遇需审批命令直接判 `requires approval` 拦下（`echo` 等安全命令有内置放行，复杂脚本没有）。
具体旗标以所安装 CLI 的官方帮助为准。

**设计立场**：工具面不收权限参数（防注入边界不变，模型不可自切档位）；档位全在插件 config，
切档 = 改 `active` + 重装 + 重启 DSH。公开样例默认 `normal`，更高权限必须由部署者明确选择；
头部的 `args` 保留 normal 基线档供回退（改 `active: normal` 即回到保守行为）。

| 档位 | codex | claude |
| --- | --- | --- |
| normal（默认） | `-s workspace-write`（保守沙箱） | 裸 `-p`（无权限旗标） |
| 批限 | `-c 'sandbox_workspace_write.writable_roots=[...]` 或 `--add-dir`：目录白名单，实测放开 `~/.dsh` 后写 `cordis.yml` 通过、banner 显示沙箱扩展；网络/越界写仍拦 | `--allowedTools 'Bash(bash …/preflight.sh)'` 等命令白名单，实测精确放行 preflight.sh；规则也可写 `~/.claude/settings.json` 的 `permissions.allow`（新进程即时生效、无需重启 DSH） |
| yolo | `--dangerously-bypass-approvals-and-sandbox`（宿主机无界；headless 无交互确认） | `--permission-mode bypassPermissions` 或 `--dangerously-skip-permissions`（跳过 CLI 权限检查） |

配置形态（codex/claude 通用；解析失败在 apply 时 fail loud）：

```yaml
args: ['...']              # normal 基线档（缺省 = 不追加旗标，用 CLI 默认）
argsProfiles:
  active: normal           # 当下生效档；省略 = normal
  normal: ['...']          # 与 args 并存时 args 胜出；有具名档时必须提供 normal
  yolo: ['...']            # 具名档位名字任取（restart / batch / yolo …）
```

`cordis.patch.yml` 只保留可审阅的示例档位；请按部署边界定义最小目录或命令白名单。

### 2.4 使用

- `codex(prompt=..., model=? )` 同步阻塞；`codex(prompt=..., model=?, run_in_background=true)` 返回 jobId
  （省略 `model` 用默认）。**后台收数最佳实践**（同样适用于 `claude_code`）：

  1. 拿到 jobId 后**优先继续做与该任务无关的独立工作**——job 完成时父会话会自动收到 completion
     notice（不用轮询，通知会找你）。
  2. 确实没有独立工作、下一步又强依赖结果时，才 `job_output(job_id, wait: true, timeout_ms: N)` 阻塞等待：
     完成即提前返回；到时返回 `[status: running]`，job 继续存活，可再次等待。`timeout_ms` 默认 30s、
     上限 600s（`tool-jobs` 的 `waitTimeoutMs`/`maxWaitTimeoutMs` 配置可调；若需要 1 小时上限，
     可使用本仓库的示例 preset——注意 web 面该配置只能落在 **agent preset** 的行上，
     见 `plugins/manual/code-longwait-preset`；用户补丁层的宿主面 tool-jobs 行被 web-app
     disabled，写在那里不生效）。
  3. **不要 sleep、不要定时轮询**——等待语义 `wait:true` 已内置，空转轮询只会白烧上下文与轮次。
  4. 废弃不用的 job 用 `job_kill` 回收。
- `codex_models` 拉当前有效模型集合；`claude_code(prompt=...)` 同理（其 description 会带出当前权限档位）。

### 2.4.1 v2.4 session 连续性（resume；仅 codex 路由）

**改动**：codex 路由 spawn 恒带 `--json`（stdout 变纯 JSONL 事件流，日志走 stderr），
provider 从首事件 `thread.started.thread_id` 提取 **session id**，stderr banner 的
`session id:` 行作副源兜底；最终回答取最后一条 `agent_message`。结果（前台 `sessionId`
字段 / 输出末尾 `session id:` 尾行）把 id 交回父 agent，下一轮把它原样传回 `session_id`
参数即可续接同一 codex 会话（多轮迭代免重发全部上文）。

**铁律（部署者决定，2026-08-31）**：session id 是 resume 的唯一钥匙，「成功必有 id」——
completed 而双源都拿不到 id 时**按失败上报**（diagnostic 附 stdout/stderr 尾巴），绝不
静默返回无 id 的成功。codex 升级后若事件格式漂移，用单测 fixture
（`test/codex-output.test.mjs`）+ `echo hi | codex exec --json -` 真实输出复核。

**机制边界（0.146.0 实测）**：

| 事实 | 证据 |
| --- | --- |
| resume **无 `-s` 旗标**（结构性不收），权限继承原会话 | `unexpected argument '-s'`；read-only 会话 resume 后写文件被拒 |
| 沙箱可用 `-c sandbox_mode=<mode>` 显式放开/收紧 | read-only 会话 resume 带 `-c sandbox_mode=workspace-write` 写文件成功 |
| 省略 `-m` 时继承原会话模型；显式 `-m` 可换模型 | resume 无 `-m` 时 banner 显示原模型 |
| `--ephemeral` 会话不落盘、不可 resume | help 明示；config 校验 fail loud 拒绝该组合 |
| resume + `--json` 回显同一 `thread_id` | 实测 |

**配置面**：`codex.resumeArgs`（默认 `['--json', '--skip-git-repo-check']`）是 resume
argv 的唯一旗标旋钮——resume 路径 argv 从零构建（`exec resume [resumeArgs] [extraArgs]
[-m model]? <sid> -`），**不与 args/argsProfiles 叠加、不去重、不做魔法过滤**。
`codex.stdoutMaxBytes`（默认 256KB）控制 stdout 内存尾窗，另开 8 倍 spill 文件保头
（`thread.started` 是首行，超窗也不丢 id）。claude 路由无此能力（`--resume`/`--continue`
语义不同）。并发多个 codex 会话时各用各的 id；同 session 的续接由父 agent 串行化。

### 2.4.2 Claude session 连续性（package v0.5.1）

启用 `claude.sessionSupport` 后，新会话由工具生成 UUID 并通过 `--session-id` 传给 CLI；后续把结果里的
`session id:` 原样传回 `session_id`，provider 会改用 `--resume`。`resumeArg` 与 `newSessionArg` 可配置，
非法 UUID 在进入 argv 前即被拒绝。关闭该开关时，工具 schema 不暴露 `session_id`。


### 2.5 验证

```
node scripts/preflight.mjs && npm test          # import 预检 + 单测（route/description/同步异步/取消链）
# 装完重启后，在会话里让模型调 codex / codex_models / claude_code；看启动日志有无 provider/工具挂载。
```

## 3. 怎么回滚

```
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-external-agents
# 重启 DSH
# 或还原 config + 重启（v2→旧多工具写法见 DESIGN.md §7）
```

## 4. 集成踩坑 / 已知降级（带证据）

- **codex 自定义 provider 必须给 `name` 覆盖（v2 实测修复）**：`-c model_providers.<id>.name=<id>` 缺一不可——
  codex 0.146 的 `ModelProviderInfo` 要求 `name` 非空，缺它 `-c` 覆盖在 config 加载即报
  `provider name must not be empty`。补上后 `base_url/wire_api/env_key` 覆盖才会完整生效。
- **“OpenAI-compatible” 不是完整兼容性证明**：接入第三方 provider 前，分别验证实际使用的 Responses
  或 Messages 协议、流式生命周期、错误语义与取消；不要只凭接口名称或单次非流式返回判定可用。
- **`codex exec` 非交互审批**：`codex exec` 天生 `approval: never`（2026-08-28 实测 banner 确认），不存在「卡审批」，
  只有沙箱边界。保留沙箱的正道是 `-s/--sandbox`（`read-only` / `workspace-write` / `danger-full-access`）+
  `-c sandbox_workspace_write.writable_roots=[...]` 目录批限。本插件默认 `-s workspace-write`，yolo 档
  （`--dangerously-bypass-approvals-and-sandbox`）只在 config 里预置、不默认启用。
- **环境变量 scrub**：subprocess 会 scrub credential 形 env（`ANTHROPIC_API_KEY` 等），claude 需靠自己的
  `settings.json` 或 `config.claude.env` 显式转发。
- **prompt 走 stdin 而非命令行**：避免引号/长度问题，也防 CLI 误读宿主 stdin pipe。
- **输出取 stdout 退 stderr**：错误路径最终回应常落 stderr；`stopReason:'error'` 时把 stderr 一并回给模型。
- **codex 对未收录模型可能打 metadata 警告**：这通常会退回 fallback metadata；是否影响能力与性能需
  对具体 provider 做完整验证。

## 5. 上下文占用权衡（重要，用之前先想清楚）

每次调用把任务 prompt 发出去、把子 agent 完整输出收回来塞进主 session 上下文——高频 `codex`/`claude_code`
= 主会话上下文快速膨胀（可能更早 compaction）。换的是干净子上下文 + 更细执行控制。决策要点：

- 一次性的、边界清晰的、需大工具体量的 → 派外部 agent。
- 与主会话强耦合、需来回改的 → 在主会话直接做。
- 长任务优先 `run_in_background: true`，别让主 session 干等；收数按 §2.4 的最佳实践（等通知，
  或 `job_output(wait:true)` 带上限等待），绝不 sleep/轮询。

## 6. 边界：什么时候用 Codex / Claude

启发式默认（非硬编码，按需覆盖，作者经验不固化为客观排名）：

| 维度 | Codex（`codex`） | Claude Code（`claude_code`） |
| --- | --- | --- |
| 工具调用 | 稳定、强迫症式：同工具反复触发也不散 | 工具面丰富、节奏快 |
| 适合 | 测试/审计/校验、需要 computer/browser 等独有工具 | 实现/长文档产出 |
| 注意 | 开发类有时过度思考，提示词里收口（限轮次、先最小实现） | 非交互权限由插件 config 档位控制（见 §2.3），模型不可自切 |

这份分工只是作者经验，不是模型能力排名；编排应由上层工作流按任务与实测结果决定。
