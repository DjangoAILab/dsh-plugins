# dsh-safe-restart — DSH 安全重启交接约定（委托外部 Agent，绝不自己重启自己）

> 一句话：DSH agent 跑在 DSH web 进程内，**绝不自己执行重启**——重启 = 杀掉自己所在进程，
> 命令一经发出就失去对「新实例是否恢复、插件是否加载、要不要回滚」等一切后续的控制。重启必须
> **委托给外部 Agent**（Codex 优先，Claude Code 备选），交接时把「要做什么 / 预检什么 / 出问题怎么办」
> 一次交代清楚。

## 何时读

- 任何「必须重启 DSH 才生效」的变更做完之后（bundle 插件 add/update/remove、runtime 升级、daemon 配置调整等）。
- 要写「重启 + 事后验证 + 故障处置」的交接指令时。

## 机制事实（为什么不能自己重启）

DSH agent 跑在 DSH web 进程内。重启 = 杀掉自己所在进程；即使走 launchd 的 `kickstart -k`（守护会拉起
新实例），agent 也会在命令发出后立刻失联，无法：

1. 确认新实例健康（HTTP 200）；
2. 确认 bundle 插件真加载（工具出现 / 入口无 `ERR_MODULE_NOT_FOUND`）；
3. 出问题时回滚（`plugin remove`）或改依赖。

外部 Agent（Codex / Claude）不在 DSH 进程内，重启后仍存活，能继续观察与处置。
完整机制证据见 [plugin-loading-and-hot-reload](../../foundations/plugin-loading-and-hot-reload.md)。

## 交接指令模板（Codex 优先，Claude 备选）

把下面这段直接交给 `codex exec`（或 `claude -p`）执行、按步骤回报：

```
我要重启 DSH web（launchd 服务 org.example.dsh-web，监听 http://127.0.0.1:3080）。
请按顺序执行、每步回报结果；任一步失败就停在该步并把报错贴回来，不要擅自继续：

1. 预检（不停服务）：bash <repo>/plugins/manual/web-remote-access/daemon/preflight.sh
   失败 → 停；缺失 peer / 入口语法错 / 包解析失败都会在此拦截。
2. 重启：bash <repo>/plugins/manual/web-remote-access/daemon/restart.sh
3. 验证恢复：轮询 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080 直到 200（约 60s 超时）。
4. 验证插件：dsh plugin --profile web list（看目标 bundle 是否在、工具是否加载）。
5. 看日志：tail -n 200 ~/.dsh/dsh-web.log，确认无 ERR_MODULE_NOT_FOUND、无 launchd KeepAlive 崩溃循环。
6. 出问题按优先级处置：
   a. 入口 ERR_MODULE_NOT_FOUND（缺 peer / link: 越界）→ 改用 file: 重装：
      dsh plugin --profile web remove <name> && dsh plugin --profile web add file:/abs/path
      然后回到第 1 步。
   b. 插件 apply() 运行期报错 → 贴日志，先 plugin remove 回滚止损，再排查。
   c. 进程起不来 / KeepAlive 循环 → 贴 launchctl list 与日志；必要时 plugin remove 回滚并报告。
```

> 模板里的 `<repo>` / `<name>` / 路径用真实值替换；故障处置规则可按具体插件补充。

## 为什么 Codex 优先

- Codex 工具调用稳定、适合「照清单逐项执行 + 读日志判定 + 出问题给处置」这类审计/操作活，
  这能保持“当前进程之外另有执行者负责恢复”的独立性。
- Claude 备选亦能独立完成同样步骤；关键是**执行者不在 DSH 进程内**，重启后仍存活。

## 前置条件 / 幂等性

- launchd 服务 `org.example.dsh-web` 已装（`daemon/install.sh`），`restart.sh` / `preflight.sh` 就位。
- 本交接可重复执行：preflight 只读、restart 幂等（kickstart -k）、验证可复查。
- 极端情况下外部 Agent 也不可用 → 宁可**延后重启、让当前进程继续兜底**，也不让 DSH agent 自重启。
