# dsh-external-agents v2 设计（单工具 + model 参数 + 灵活后端 + 继承异步）

> 目标：把 codex 从「每模型一个工具」升级为「一个 `codex` 工具 + `model` 参数」，
> provider/model 全部由插件配置驱动，异步继承 DSH 原生 `ctx.jobs`（不重造；收数语义见 §8）。
> 本文档是落地实现的单一权威来源；实现 session 先读本文再动手。

> **落地状态：已按本文 §5 实现（2026-08-18）。** 实现细节见 `src/route.mjs`（配置解析+校验）、
> `src/tool.mjs`（自写单工具+codex_models）、重构后的 `src/index.mjs`（route provider 注册+挂载），
> 单测见 `test/`，import preflight 见 `scripts/preflight.mjs`。§6 的待验证点已有定论（见该节）。

## 1. 结论（方案 D）

**一个薄自写工具 + 内部 route provider + 原生 `ctx.jobs`。**
放弃 `dsh-tool-subagent`（其 schema 写死、无 model 参数、无参数透传钩子），但异步能力不是重造，而是直接借用：

- 同步：`ctx.subagents.start(routeProvider, { prompt, parent, signal })` → await `run.result` → `run.dispose()`。
- 异步：`ctx.jobs.start(...)`（Job 名 `subagent-N`），`job_output`/`job_kill` 由 DSH 已有 `dsh-tool-jobs` 直接读/取消，零自研；
  取消链 = `job_kill → jobs.kill → AbortSignal → provider → subprocess 树级终止`。收尾复用官方 `settleRun(run)`。

## 2. 配置面（provider/model 灵活，与 DSH 主模型选择器解耦）

```yaml
codex:
  toolName: codex            # 唯一模型可见工具名
  command: codex
  args: ['exec', '--skip-git-repo-check', '-s', 'workspace-write']
  defaultModel: fast
  providers:
    builtin:                 # codex 内置 OpenAI（无需 baseUrl/key）
      type: builtin
    gateway:                 # OpenAI-compatible provider
      baseUrl: 'https://api.example.com/v1'
      wireApi: responses
      envKey: THIRD_PARTY_API_KEY
      apiKey: '${ENV:THIRD_PARTY_API_KEY}'
  models:                    # 模型可见别名 -> route（provider + 实际 model）
    fast: { provider: gateway, model: provider-model-fast }
    pro:  { provider: gateway, model: provider-model-pro }
```

设计原则：
- `providers`/`models` 全在插件配置，不读 DSH 主会话 model selector。
- 工具只收「模型别名」，不收 baseUrl/key/provider/argv（防注入）。
- 配置错误（重复 route、未知 provider、缺 defaultModel、provider 的 models allowlist 不符）在启动时 fail loud。

### 2.1 权限档位（v2.2 `argsProfiles`）

**问题**：headless 一次性运行没有人工审批面（机制与验证方式见 README §2.3）：
`codex exec` 天生 `approval: never`，卡的是文件沙箱；`claude -p` 无沙箱但自带权限系统，需审批命令直接拦。
「放开」只有两条正道：yolo 全量信任，或批限白名单；都属于部署者的显式配置选择。

**设计**：codex/claude 共享 `resolveArgsProfiles()`（route.mjs 纯函数，单测覆盖）——
`args` = normal 基线档；`argsProfiles` = 具名档位 map + `active`；解析失败 apply 时 fail loud。
legacy 配置（只有 `args` 或全缺省）原样可用：全缺省 = 空 normal 档（CLI 默认旗标）。
一旦出现具名档位，强制要求 normal 基线并存——保守档必须始终可用、可回退。
**工具面不给模型暴露权限参数**（§2 防注入边界延伸），切档 = 改 config + 重装 + 重启 DSH。
挂载日志会打出 `args profile "<active>" (available: ...)`，运行期档位一眼可查。

## 3. 模型列表如何暴露给 Agent（策略：两个都要）

1. **`codex` 工具 description 动态列举**（primary）：apply 时从 config 生成，
   形如 `可用 model：fast / pro（默认 fast）`。
   Agent 在 system prompt 里直接看到、零额外 round-trip。
2. **`codex_models` 查询工具**（secondary，`isConcurrencySafe`）：返回「别名 → provider → 实际 model」映射，
   供 Agent 需要时刷新/枚举（模型多了或动态变化时兜底）。

> 为什么两个都要：模型少且稳定时 description 已够用（省一次工具调用）；但 config 可能随发布变，
> 留一个 list 工具保证 Agent 永远能拿到「当下有效的模型集合」，而不是依赖过期的 description。

## 4. 依赖声明与安装（响应冷启动 ERR_MODULE 的健壮性定论）

- 根因：`link:` 装法让 Node 跟随 symlink 回到源码真实路径，从仓库向上找不到 `$DSH_HOME/profiles/node_modules` 的 fallback。
- **不改用 `dependencies` 装宿主基础包**（会形成第二套 cordis/dsh-*，身份/版本漂移风险大）。
- 最终 `package.json`（实现 BCD 后）：
  `peerDependencies: { @deepseek-ai/cordis: "4.0.1", @deepseek-ai/dsh-subagent: "0.1.0-rc.7", @deepseek-ai/dsh-tools: "0.1.0-rc.7", @deepseek-ai/dsh-jobs: "0.1.0-rc.7" }`，
  **删掉 `@deepseek-ai/dsh-tool-subagent`**（不再用）。版本写死、不带 `^`。
- 生产安装唯二要求：从仓库根目录使用 `file:$PWD/...` + 冷启动前跑 import preflight。

## 5. 实现步骤

1. 改 `package.json`：peer 精确 pin + 删 dsh-tool-subagent（若已自写工具）。
2. 保留 `src/provider.mjs`（出进程 provider + `ctx.subprocess`，基本不动），改名为「route provider」；
   每个 route = 独立内部 provider 名 `external:codex:<model别名>`，config 解析出 provider + 实际 model。
3. 新增 `src/tool.mjs`：`ctx.tools.register({ name:'codex', parameters: { model, prompt, run_in_background }, execute })`；
   同步分支 + 异步分支（`ctx.jobs.start` + `settleRun`）按 §1。
4. 新增 `codex_models` 工具（返回模型→route→provider 映射）。
5. 卸载 `ctx.plugin(toolSubagent,...)` 相关代码（index.mjs 不再 import dsh-tool-subagent）。
6. 单测：route 解析、description 动态列举、同步/异步、取消链；preflight 通过。

## 6. 第三方 provider 兼容性

Codex 自定义 OpenAI Responses provider 需要同时覆盖
`model_providers.<id>.name/base_url/wire_api/env_key`；缺少 `name` 会在配置加载时报
`provider name must not be empty`。插件负责生成这些覆盖，但“兼容 OpenAI/Anthropic”只是入口声明，
不是完整兼容性证明。每个部署都应针对所用模型验证 Responses 或 Messages 请求、流式生命周期、
错误语义、取消与长输出，再把该 route 暴露给 agent。密钥只通过 `${ENV:...}` 引用传入。

## 7. 兼容与回滚

- 现阶段「多工具」（codex_deepseek/codex_glm/codex_qwen）在 config.codex.models 里；v2 改为 `models: {别名:{provider,model}}` + 单工具后，
  旧的 `models: [{model,toolName}]` 数组写法废弃，实现时保留一个兼容映射或直接替换。
- 回滚：还原 config + 重启 DSH（bundle 冷启动）。

## 8. 后台 Job 收数语义与最佳实践（v2.3，2026-08-31 调研定论）

> 结论：**不新增 sleep/wait 工具。**「带最大等待时长的等待、完成即提前返回」已由原生
> `job_output(job_id, wait: true, timeout_ms)` 完整覆盖；新增独立 sleep 工具只会制造一个看不到增量输出、
> 更容易诱导空转轮询的竞品。本节是工具文案与 README 措辞的机制依据（单测
> `test/tool.test.mjs` 的 guidance 断言防回退）。调研为双路独立核查（主会话 + codex 交叉验证，2026-08-31）。

**机制证据**（`@deepseek-ai/dsh-tool-jobs@0.1.1-rc.2 lib/index.js` 与 `@deepseek-ai/dsh-jobs-local lib/index.js`）：

1. **等待语义**：`job_output` execute 在 `wait === true` 时先 `await ctx.jobs.wait(id, timeout, exec.agent, exec.signal)`
   再 read；`jobs.wait` 用 `deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)` 融合调用方取消与超时——
   job settle 时 `settle()` 先 resolve 全部 `waitResolvers`（**完成即提前返回**），超时分支 resolve 正常
   返回当前 snapshot（**到时返回 `[status: running]`，job 存活**），外部取消才 reject "wait aborted"。
2. **参数边界**：`timeout_ms` 缺省用 `waitTimeoutMs`（默认 30s），硬上限 `Math.min(timeout, maxWaitTimeoutMs)`
   （默认 600s）；两者都是 `tool-jobs` 插件 config，部署者可调大。
3. **完成自动通知**：`ctx.jobs.onJobDone` 给 owner 投 notice——owner 忙则 `inject` 进下一步，owner idle
   则默认 `wakeup` 唤醒开新回合（`maxConsecutiveWakes` 默认 3，用户消息到达即重置预算）。**等待中的 job
   settle 时 `waiters > 0 → reported = true`，不重复投 notice**——主动等待与被动通知不叠加。
4. **读取是增量**：`job_output` 对 stream job 返回「自上次读取以来的新增输出」；独立 sleep 工具拿不到增量，
   sleep 后仍要 `job_output`，徒增一次糊涂选择。

**因此插件只做三件事**（本节即实现清单）：

- 三个工具的 description / `run_in_background` 参数文案、后台 jobId 的 render 输出统一携带
  `BACKEND_JOB_GUIDANCE`（`src/tool.mjs` 导出常量）：先做独立工作等通知；确需阻塞才
  `wait:true`；点名 **不要 sleep/轮询**；`job_kill` 回收。
- README §2.4 固化四步最佳实践；边界一节纠正「外部进程收不到完成推送」的旧表述
  （完成 notice 与子 agent 是否 continuable 无关，producer 侧无需任何配合）。
- 极端长任务（单次 wait 600s 不够）的正解是部署者调 `tool-jobs` 的 `maxWaitTimeoutMs`，
  或干脆让完成通知唤醒，而不是加等待工具。**web 面的配置落点是 agent preset 的行**
  （需要 1 小时上限可参考 `plugins/manual/code-longwait-preset`；profile 用户
  补丁层的宿主面 tool-jobs 行被 web-app patch disabled，写在那里不生效）。

## 9. v2.4 codex session 连续性（session id 捕获 + resume，2026-08-31 定论）

> 结论：**「成功必有 id」**。session id 是 resume 的唯一钥匙，codex 路由 spawn 恒带
> `--json`（不提供关闭逃生门），completed 而双源（JSONL 首事件 `thread.started.thread_id`
> 主源 + banner `session id:` 副源）都拿不到 id 时按失败上报，绝不静默降级成无 id 的成功。
> 设计与 Codex 本体互审两轮（本轮修复：argv 从零构建、schema sessionId 可选、--ephemeral
> apply 期 fail loud、claude 另开版本），端到端冒烟（真实 codex + 真实 provider 代码路径：
> 第一轮拿 id、第二轮 resume 回显同 id 且记住第一轮 BANANA-42）通过后定稿。

### 9.1 实测机制事实（codex-cli 0.146.0，升级需复核）

1. `codex exec --json`：stdout 纯 JSONL，日志全在 stderr；首事件
   `{"type":"thread.started","thread_id":"<uuid>"}`；最终回答 = 最后一条非空
   `item.completed` 且 `item.type==='agent_message'` 的 `item.text`。
2. `codex exec resume <SID> [flags] -`：stdin 哨兵可用；**无 `-s` 旗标**（结构性不收，
   与 flags/SID 顺序无关），权限继承原会话；`-c sandbox_mode=` 可显式放开/收紧（实测
   read-only 会话放开成 workspace-write 且写文件成功）；省略 `-m` 继承原会话模型。
3. resume + `--json` 回显同一 `thread_id`（完整性校验）；`--skip-git-repo-check` 是
   resume 硬前置（非信任目录不带给它直接报错）；`--ephemeral` 不落盘不可 resume。
4. DSH 机制：`ctx.subagents.start` spread 透传 request（自定义 `sessionId` 字段直达
   provider）；`settleRunResult` 对 completed 原样返回 attempt() 对象（`result.sessionId`
   前台直达工具层）；后台 `runOutcome` 只保留 output 文本 → sessionId 靠 render 尾行携带；
   collector 保尾 + spill 保头（stdout spill = thread.started 首行永在手）。

### 9.2 实现清单（本节即验收清单）

- `src/codex-output.mjs`：纯函数（isUuid / parseJsonlOutput 逐行抗损 /
  parseBannerSessionId / extractCodexOutput 双源 / missingSessionIdReason /
  sessionFooter），fixture 锁 0.146.0 事件形态。
- `src/route.mjs`：active args 自动补 `--json`；`resumeArgs`（默认
  `['--json','--skip-git-repo-check']`）透传 + 补 `--json` + fail loud 拒
  `--ephemeral`；`stdoutMaxBytes`（默认 256KB）。
- `src/provider.mjs`：codex 分叉 = JSONL 捕获 + stdout spill 保头 + resume argv
  从零构建（不与 args/argsProfiles 叠加、不去重）；completed 无 id → error +
  diagnostic；session_id 非 UUID 在 spawn 前拒绝。
- `src/tool.mjs`：`session_id` 参数（UUID 防注入校验）+ schema 可选 `sessionId` +
  render 尾行 + description 教父模型回传；插件零会话状态存储，拒绝 `--last`（并发歧义）。
- 已知未做：跨 provider resume（builtin ↔ 自定义网关）行为未实测；claude session
  连续性自 v2.5 起使用独立的 `--session-id` / `--resume` 路径；同 session 并发 resume 由父模型串行化（插件 `isConcurrencySafe`
  是静态声明，检测不了）。
