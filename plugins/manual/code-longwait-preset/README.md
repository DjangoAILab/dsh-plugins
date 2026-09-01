# code-longwait-preset —— 「Code + 1h Job Wait」Agent preset

> 一句话：shipped `code` preset（PTC 模式）的**完整拷贝**，唯一差异是 `tool-jobs` 行加
> `config: { waitTimeoutMs: 30000, maxWaitTimeoutMs: 3600000 }`——把 `job_output(wait: true)` 的
> 单次阻塞等待硬上限从默认 600s 提到 1 小时。服务「派后台外部 agent 后真被阻塞等结果」的场景。
> 原 preset 来自 DeepSeek Harness（MIT）；模块内保留其 `LICENSE`。

## 何时读本文件

- 要把 DSH 的 job 等待上限调到 1 小时、或升级 DSH 后重新套用本 preset 时。
- 要理解「为什么改等待上限必须动 preset、而动用户补丁层无效」时（机制见下）。

## 为什么必须做成 preset（机制，2026-08-31 实证）

1. web 面（`@deepseek-ai/dsh-web-app` 的 bundle patch）把宿主面的 `tool-jobs` 行 **disabled**
   （`disabled: true`），job registry 留宿主面，模型可见的 `job_*` 工具改由 **agent preset** 的
   组合行挂载。所以往 profile 用户补丁层（`cordis.patch.yml`）写 tool-jobs config 是**死配置**。
2. 会话实际挂的 preset 行在 shipped 组合
   `runtime/current/.../dsh/config/agent-presets/code/agent.cordis.yml`（只读，升级会覆盖）。
3. shipped root 在 preset 发现顺序里先于用户 root（`$DSH_HOME/.agent-presets`），同名 `code`
   拷贝**不会胜出**（first-root-wins）→ 正道是新 id 完整拷贝再改。

## 改了什么

- `agent.cordis.yml` —— shipped `code` 组合的完整拷贝，仅 `tool-jobs` 行加 config（带注释）。
- `preset.yml` —— 显示名 `Code + 1h Job Wait` 与描述；`order: 2` 与原 PTC 对齐。

## 怎么生效

```bash
mkdir -p ~/.dsh/.agent-presets/code-longwait
cp agent.cordis.yml preset.yml ~/.dsh/.agent-presets/code-longwait/
```

再把 `~/.dsh/settings.yaml` 的默认 preset 切过去（settings 热加载，无需重启）：

```yaml
agent-presets:
  default: code-longwait
```

验证：DSH Web 新会话的 preset 选择器出现「Code + 1h Job Wait」且为默认（运行中的会话保持
原 preset，新会话生效）。`--dump-config --patch <agent.cordis.yml>` 可校验 YAML 可解析。

## 怎么回滚

`~/.dsh/settings.yaml` 改回 `default: code`，删除 `~/.dsh/.agent-presets/code-longwait/`。

## 维护提示

DSH 升级若改了 shipped `code` 组合，本 preset 不会自动跟随——重新拷贝一次并重放 tool-jobs
config 差异（`diff` 对照 runtime 里的 `config/agent-presets/code/agent.cordis.yml`）。
