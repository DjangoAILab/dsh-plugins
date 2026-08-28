# dsh-external-agents

把 Codex / Claude Code CLI 注册成 DSH 的出进程 subagent provider，并以模型可见工具调用。

v0.3.1 的 Codex 面采用“一个 `codex` 工具 + `model` 别名参数”，内部路由到内置或第三方
OpenAI-compatible provider；Claude 面提供独立的 `claude_code` 工具。前台执行、后台 Job 和取消链
均复用 DSH 原生能力。部署者还可以为两类 CLI 定义具名参数档位，但模型不能在工具调用时切换档位。

设计依据见 [`DESIGN.md`](DESIGN.md)。

## 何时读

- 安装、升级、验证或回滚本插件；
- 增删 Codex 模型别名或第三方 provider；
- 排查工具未出现、CLI 找不到、后台 Job 或取消异常；
- 判断某个任务是否适合交给外部 Agent。

## 1. 改了什么

### 1.1 出进程 provider

插件通过 `ctx.subagents.registerProvider(...)` 注册 route provider。每次执行使用 `ctx.subprocess.spawn`
启动 CLI：

- prompt 走 stdin；
- `exit 0` → completed；
- 非零退出 → error；
- AbortSignal → 终止子进程树；
- stdout 优先，失败时附带 stderr。

### 1.2 自写工具层

当前版本不再依赖 `@deepseek-ai/dsh-tool-subagent`：

- `codex`：参数包含 `prompt`、可选 `model` 和 `run_in_background`；
- `codex_models`：查询当前模型别名及配置路由；
- `claude_code`：调用 Claude Code CLI，可在配置中固定模型或 Anthropic-compatible provider。

工具只接受模型别名，不允许单次调用传入 base URL、密钥、provider 或 argv。

### 1.3 原生后台 Job

- 前台：等待 subagent run 完成并释放；
- 后台：直接调用 `ctx.jobs.start(...)`，立即返回 Job id；
- 读取：使用 DSH 已有的 `job_output`；
- 取消：`job_kill → AbortSignal → subprocess terminate()`。

后台 Job 是 DSH 原生能力，本插件没有实现第二套调度器。

### 1.4 配置 fail-loud

以下情况在插件加载时直接报错：

- 未定义 command；
- models 为空；
- defaultModel 不存在；
- 模型引用未知 provider；
- provider allowlist 不包含目标模型；
- `${ENV:NAME}` 指向不存在的环境变量。

### 1.5 部署者控制的参数档位

`argsProfiles` 把一组 CLI argv 固定成具名档位。`normal` 是保守基线，`active` 省略时也回落到
`normal`；档位值不是数组、缺少基线或指向未知档位都会在加载时失败。工具 schema 不暴露 `active`，
因此网页或终端里的不可信内容不能让模型自行提权。切换档位必须由部署者改配置、重新安装并冷启动 DSH。

## 2. 怎么生效

### 2.1 前置条件

- Node.js 22 或更高版本；
- DSH `0.1.0-rc.7`；
- 本机已安装并登录需要使用的 Codex / Claude Code CLI；
- DSH profile 已加载 Jobs 和 Job 工具。

### 2.2 安装

从仓库根目录执行，使用 `file:`，不要使用 `link:`：

```bash
node "$HOME/.dsh/runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add \
  "file:$PWD/plugins/manual/dsh-external-agents"
```

安装后进入 profile 的安装副本验证：

```bash
cd "$HOME/.dsh/profiles/web/node_modules/dsh-external-agents"
node scripts/preflight.mjs
npm test
```

这是 bundle 插件，配置或版本变更后必须冷启动 DSH。不要让当前 DSH 会话直接杀掉承载自己的进程；
由用户、服务管理器或外部守护进程执行重启和恢复验证。

### 2.3 配置示例

下面只使用占位模型和 RFC 示例域名。替换成自己的服务后必须单独验证协议兼容性。

```yaml
codex:
  enabled: true
  command: codex
  args: ['exec', '--skip-git-repo-check', '-s', 'workspace-write']
  argsProfiles:
    active: normal
    read-only: ['exec', '--skip-git-repo-check', '-s', 'read-only']
  defaultModel: fast
  providers:
    builtin:
      type: builtin
    gateway:
      baseUrl: 'https://api.example.com/v1'
      wireApi: responses
      envKey: THIRD_PARTY_API_KEY
      apiKey: '${ENV:THIRD_PARTY_API_KEY}'
      models: ['provider-model-fast', 'provider-model-pro']
  models:
    fast: { provider: gateway, model: provider-model-fast }
    pro:  { provider: gateway, model: provider-model-pro }
    builtin-default: { provider: builtin, model: '<codex-model-id>' }

claude:
  enabled: true
  command: claude
  args: ['--print', '--output-format', 'text']
  argsProfiles:
    active: normal
    batch: ['--print', '--output-format', 'text', '--allowedTools', 'Bash(npm test:*)']
  # model: '<claude-model-id>'
  # provider: gateway
  # providers:
  #   gateway:
  #     baseUrl: 'https://api.example.com'
  #     apiKey: '${ENV:THIRD_PARTY_ANTHROPIC_KEY}'
```

可选全局配置：

- `graceMs`：SIGTERM 到 SIGKILL 的宽限时间；
- `maxOutputBytes`：stdout/stderr 缓冲上限；
- `cwd` / `env`：每个 CLI 的工作目录和显式环境变量。

### 2.4 使用

```text
codex(prompt=..., model="fast")
codex(prompt=..., model="pro", run_in_background=true)
codex_models()
claude_code(prompt=...)
```

后台调用返回 Job id 后，使用 `job_output` 轮询、`job_kill` 取消。

## 3. 怎么验证

```bash
cd "$HOME/.dsh/profiles/web/node_modules/dsh-external-agents"
node scripts/preflight.mjs
npm test
```

测试覆盖 route 解析、自定义 provider 参数、参数档位、配置失败、单工具模型选择、前后台分支、取消信号
和 Claude 工具注册。重启 DSH 后还应做最小真实验收：

1. `codex_models` 返回预期别名；
2. 每个别名分别完成一个只返回固定文本的任务；
3. 后台任务可通过 `job_output` 收口；
4. 一个长任务能被 `job_kill` 取消；
5. DSH 日志没有 provider 或工具挂载错误。

第三方 endpoint 的单元测试只能证明参数构造正确，不能证明目标服务完整兼容 Responses 或 Anthropic
协议。真实端点必须分别验证非流式、流式、错误和取消路径。

## 4. 怎么回滚

```bash
node "$HOME/.dsh/runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web remove dsh-external-agents
```

然后冷启动 DSH。若只需回滚配置，可恢复之前的 profile 配置后冷启动。

## 5. 已知边界与踩坑

- **One-shot**：外部 CLI 每次独立运行，无 resume、持久会话和过程流。
- **文本结果**：插件不解析 Codex/Claude 原生事件协议，只收口 stdout/stderr。
- **输出上限**：超过 `maxOutputBytes` 会截断。
- **无实际上游归因**：`codex_models` 展示配置路由；第三方网关内部 fallback 不在插件可观测范围内。
- **自定义 Codex provider 需要 `name`**：插件会同时生成
  `model_providers.<id>.name=<id>`；缺失时部分 Codex 版本会拒绝加载 provider。
- **端点兼容不由插件保证**：名称写着 OpenAI-compatible 不代表完整实现 Responses API。
- **prompt 走 stdin**：避免命令行引号、长度和进程列表暴露问题。
- **非交互不等于无沙箱**：示例保留受限执行边界；更高权限档位必须由部署者显式定义和选择。
- **源码目录测试限制**：宿主 peer 由 DSH profile 提供，完整测试应在 `file:` 安装副本中运行；源码目录
  只适合执行无宿主依赖的纯函数测试。

## 6. 上下文成本

外部 Agent 的任务和完整结果最终都会进入父 session。高频调用会更快消耗上下文，换来的是独立、干净的
子上下文和更细的执行控制。

- 边界清晰、一次性、需要大量外部工具的任务：适合委派；
- 与主会话强耦合、需要频繁往返修改的任务：更适合留在主会话；
- 长任务优先后台运行，但后台不会减少最终结果进入上下文的成本。

## 7. Codex / Claude 分工

下面只是使用启发式，不是模型排名：

| 维度 | Codex | Claude Code |
| --- | --- | --- |
| 常见用途 | 测试、审计、逐项核对 | 实现、长文档 |
| 配置重点 | model alias、Responses provider、sandbox | model、Anthropic provider、permission mode |
| 共同边界 | 一次性外部进程、文本结果、需要自包含 prompt | 一次性外部进程、文本结果、需要自包含 prompt |
