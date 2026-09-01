# job-wait-config-surface — job_output 等待参数在 web 面的配置落点（preset 行，非用户补丁层）

## 是什么 / 为什么

DSH 原生 `job_output(job_id, wait: true, timeout_ms)` 是「带最大等待时长、完成即提前返回」的
阻塞等待：等待中 job settle 时 `jobs.wait` 立即 resolve（`settle()` 释放全部 `waitResolvers`）；
超时则返回 `[status: running]` 且 job 存活可再等。默认等待 `waitTimeoutMs`（30s）、硬上限
`maxWaitTimeoutMs`（600s），均属 `@deepseek-ai/dsh-tool-jobs` 的插件 config。

**web 部署面上，这个 config 不能写在 profile 用户补丁层**——要落到 **agent preset 组合的行**上：

1. `@deepseek-ai/dsh-web-app` 的 bundle patch 把宿主面 `tool-jobs` 行 `disabled: true`
   （同批还有 tool-bash / tool-fs / tool-subagent 等）。注释明言：background-job **registry**
   留宿主面，模型可见的 `job_*` 控制工具移到 preset 面（证据：web-app `cordis.patch.yml`
   「the agent plane moves behind agent presets」一节）。
2. 会话真正挂载的行来自 preset 组合，shipped 的在
   `runtime/current/node_modules/@deepseek-ai/dsh/config/agent-presets/<id>/agent.cordis.yml`。
   例如 `code` preset 的 `- id: tool-jobs` 行（无 config → 官方默认）。
3. preset 发现是 **first-root-wins** 且 shipped root 先于用户 root
   （`dsh-agent-presets` `resolvedRoots`：configured roots 在前，`$DSH_HOME/.agent-presets`
   追加在后；`discoverPresets` 逐 root `if (byId.has(id)) continue`）——
   **同名拷贝 shipped preset 不生效**，必须新 id 完整拷贝再改。

## 证据（2026-08-31 实测，rc.2 运行时）

- `dsh --profile web --dump-config` 中 `tool-jobs` 条目带 `disabled: true`（来源 web-app patch），
  用户补丁层加 `config` 后 dump 虽显示合并，但该行在 preset 会话中不挂载（死配置）。
- `dsh-jobs-local` `wait()`：`deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)` 融合取消与超时，
  timeout 分支 resolve（返回 running snapshot）、外部 abort 才 reject；`settle()` 先 resolve waiters，
  且 `waiters > 0 → reported = true`（等待者已读，不再重复投完成 notice）。
- `dsh-agent-presets`：`Config.roots` + `includeUserRoot`（追加 user root），`discoverPresets`
  first-root-wins；`defaultId = settings.get().default ?? config.default`——**settings 热加载**，
  改 `~/.dsh/settings.yaml` 的 `agent-presets.default` 对「此后新建的会话」生效，无需重启；
  运行中会话保持开始时的 preset（web GUI 文案明示）。

## 落地样例

本仓库 `plugins/manual/code-longwait-preset`：拷贝 shipped `code` → 新 id `code-longwait`，
唯一差异 `tool-jobs` 行加 `config: { waitTimeoutMs: 30000, maxWaitTimeoutMs: 3600000 }`。

## 实践规则

- 调 job 等待边界（或其他 preset 行的插件 config）→ 改 preset 拷贝，别写用户补丁层。
- 需要新默认 preset → 新 id 拷贝 + `settings.yaml` 切 `agent-presets.default`（热生效）。
- shipped preset 升级变更不会自动同步到拷贝，升级后需 diff 重放差异。
