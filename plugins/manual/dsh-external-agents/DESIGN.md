# dsh-external-agents v2 设计

> 目标：从“每个模型一个工具”升级为“一个 `codex` 工具 + `model` 参数”。
> provider/model 由插件配置驱动，异步直接继承 DSH 的 `ctx.jobs`，不自建调度器。

本文是当前实现的设计依据。实现位于：

- `src/route.mjs`：配置解析、校验与 route 生成；
- `src/tool.mjs`：`codex`、`codex_models`、`claude_code` 工具；
- `src/index.mjs`：provider 注册和工具挂载；
- `test/`：route、前后台执行和取消链测试；
- `scripts/preflight.mjs`：安装副本中的宿主 peer import 预检。

## 1. 方案

采用“薄自写工具 + 内部 route provider + 原生 Jobs”：

- 同步：`ctx.subagents.start(...)` 后等待 `run.result`，最后释放 run；
- 异步：`ctx.jobs.start(...)` 返回 Job id，由已有的 `job_output` / `job_kill` 读取和取消；
- 取消链：`job_kill → jobs.kill → AbortSignal → provider → subprocess terminate()`；
- 进程结果仍通过 DSH subagent 的 canonical JSON block 返回。

v2 移除了 `@deepseek-ai/dsh-tool-subagent`。原因不是重写 DSH 的 subagent，而是它的工具 schema
无法自然表达按调用选择的 `model` 参数。provider、run、Job 和取消生命周期仍然全部复用 DSH。

## 2. 配置面

```yaml
codex:
  toolName: codex
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
```

设计原则：

1. `providers` / `models` 不读取 DSH 主会话的模型选择器。
2. 模型只能传公开别名；工具参数不接受 base URL、密钥、provider id 或 argv。
3. 未知 provider、无效默认模型、空 models、allowlist 不匹配等配置在加载时直接报错。
4. 密钥使用 `${ENV:NAME}` 引用，不写入仓库。

### 2.1 参数档位

Codex 与 Claude 共用 `argsProfiles` 解析规则。`args` 定义 `normal` 基线，具名档位只由部署者配置；
`active` 默认 `normal`。工具调用不接受档位名或任意 argv，所以模型不能自行切换执行边界。出现具名档位时
必须保留 `normal`，未知档位和非法 argv 在加载时直接报错。更高权限不是默认能力，是否配置由部署环境自行
评估，并且切换需要重新安装和冷启动。

## 3. 模型发现

同时提供两种方式：

1. `codex` 的 description 动态列出别名与默认模型，避免额外工具调用；
2. `codex_models` 返回当前别名到 provider/model 的映射，供配置变化后主动刷新。

`codex_models` 展示的是插件的配置路由，不是第三方网关最终选择了哪个上游。若网关内部还有 fallback，
实际供应商归因必须由网关自己的可观测性提供。

## 4. Provider invocation

内置 Codex provider 只追加 `-m <model>`。自定义 OpenAI-compatible provider 通过 Codex 的 `-c` 覆盖：

```text
model_providers.<id>.name=<id>
model_providers.<id>.base_url=<url>
model_providers.<id>.wire_api=responses
model_providers.<id>.env_key=<env-name>
model_provider=<id>
```

`name` 不能省略。部分 Codex 版本在命令行构造 provider 时要求该字段非空；测试会验证它和其他覆盖项
同时生成。

插件只负责正确构造调用和路由。第三方端点是否完整实现 Responses API、流式事件和模型语义，必须由
部署者对目标服务单独做端到端验收。

## 5. 工具行为

### `codex`

参数：

- `description`：用于 UI 与 Job 标签；
- `prompt`：交给外部 Agent 的自包含任务；
- `model`：可选模型别名，省略时使用默认值；
- `run_in_background`：是否立即返回 Job id。

### `codex_models`

返回工具名、默认模型、命令，以及别名到 provider/model/kind 的配置映射。

### `claude_code`

采用相同的前台/后台工具生命周期。模型和可选 Anthropic-compatible provider 在插件配置中烘焙，
不向单次工具调用暴露密钥或端点参数。

## 6. 依赖与安装形态

宿主包使用精确 peer 版本，避免形成第二套 Cordis/DSH 依赖：

```json
{
  "@deepseek-ai/cordis": "4.0.1",
  "@deepseek-ai/dsh-subagent": "0.1.0-rc.7",
  "@deepseek-ai/dsh-tools": "0.1.0-rc.7",
  "@deepseek-ai/dsh-jobs": "0.1.0-rc.7"
}
```

生产安装使用 `file:/absolute/path`。`link:` 会让 Node 按源码真实路径解析依赖，可能找不到 profile 中的
peer。冷启动前应在安装副本中运行 `node scripts/preflight.mjs && npm test`。

## 7. 明确边界

- 外部 CLI 仍是 one-shot，没有 resume、进度流或持久线程引用；
- stdout/stderr 最终缓冲为文本，不解析产品原生事件协议；
- 默认输出上限由 `maxOutputBytes` 控制；
- 后台是 Job 轮询，不是进程内 continuable subagent 的推送式回调；
- 自定义端点兼容性属于端点能力，不能由插件配置成功推导。

## 8. 验证门禁

公开实现至少验证：

- provider/model route 解析；
- 自定义 provider 的完整 `-c` 参数；
- 配置 fail-loud；
- 参数档位解析、保守默认与非法配置拒绝；
- 单工具模型选择与默认模型；
- 前台结果收口；
- 后台 Job 创建与取消信号传递；
- Claude 单工具注册；
- 安装副本的 peer 和源文件 import。

## 9. 回滚

还原旧插件配置或移除插件，然后冷启动 DSH。v2 的 `models` 是对象映射，旧的“每模型一个工具”数组
写法不再作为主配置面支持。
