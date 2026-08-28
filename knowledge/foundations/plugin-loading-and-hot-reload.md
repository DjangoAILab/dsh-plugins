# plugin-loading-and-hot-reload — DSH 插件加载与热更新边界

## 事实（不可变机制）

DSH 有三种插件/补丁加载方式，**热更新能力各不相同**。其中“安装”与“激活”是两个动作：
`dsh plugin add/remove/update` 先修改 profile 的依赖与 bundle 清单；当前进程是否看见变化，
取决于加载方式。

| 方式 | 落点 | 是否热更新 | 例子 |
| --- | --- | --- | --- |
| 用户补丁层 | profile 的 `cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml` | ✅ 是（watchUserPatches + HMR 实时生效） | `web-remote-access` 的补丁 |
| 动态 Cordis 插件 | `cordis_define`/`cordis_run` 运行期加载 | ✅ 是（进当前进程） | 会话内临时插件 |
| **bundle 插件** | `dsh plugin add` → `package.json` 的 `dsh.profile.bundles` | ❌ **否，需重启** | `@liustack/modlens` |

## 为什么 bundle 插件必须重启（代码证据）

`dsh plugin` 是一个 pnpm thin forwarder：它在 profile 目录执行 pnpm，再根据已安装包是否
声明 `dsh.bundle`，协调 profile `package.json` 中的 `dsh.profile.bundles`。源码中没有向
运行中进程发送 reload/restart 的路径。

启动时 `profile-boot`（`@deepseek-ai/dsh/lib/profile-boot-*.js`）的 `composeProfile()`
把 bundle 补丁从 `profile.layers` **一次性**算出并固化在 `composed.bundlePatches`；而热更新
用的 `composeLive()` 闭包只重读那两个补丁文件，bundle 列表是启动时定死的：

```js
const composeLive = () => structuredClone([
  ...composed.bundlePatches,                                    // ← 启动时定死，不重读
  ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [], // 重读 profile cordis.patch.yml
  ...loadOptionalPatches(NAME, homePatchPath()) ?? [],            // 重读 $DSH_HOME/cordis.patch.yml
  ...composed.overlays
]);
```

`watchUserPatches()` + `@deepseek-ai/cordis-plugin-hmr` 只监听那两个 `cordis.patch.yml`，
`plugin` 命令源码里也没有任何 restart/reload/watch 触发逻辑。

**实测佐证**：进程 14:39 启动，`dsh plugin add` 在 15:28 改的 package.json，`lsof` 显示旧进程
没加载 modlens——因为它的 bundle 列表启动时就没有 modlens，也没有机制去补读。

## 结论 / 路由提示

- 仅下载或登记 bundle → 不需要为了完成“安装”而重启，旧进程会继续按旧 bundle 栈运行。
- 要让 `dsh plugin add/update/remove` 对 bundle 的变更生效 → **当前 rc.7 必须重启 DSH**；重启的**执行交接约定**（委托外部 Agent、绝不自己重启自己）见 [runbooks/dsh-safe-restart](../runbooks/dsh-safe-restart/README.md)。
- 改 `cordis.patch.yml`（profile 或 home 层）→ HMR 热生效，不必重启。
- `cordis_define`/`cordis_run` 动态插件 → 热加载进当前进程，不必重启整个 DSH。

生产 bundle 的安全激活顺序是：安装到 profile → 在旧服务仍运行时组合配置并导入所有树外
bundle 入口 → 预检成功才交给外部守护进程冷重启 → 等待 HTTP 健康检查。仓库中的
`plugins/manual/web-remote-access/daemon/restart.sh` 已内置这道入口预检；它能拦截缺依赖、
语法和入口解析错误，但插件 `apply()` 的运行期错误仍只能由启动健康检查发现。

## 当前版本代码证据（`@deepseek-ai/dsh@0.1.0-rc.7`）

- `@deepseek-ai/dsh/lib/plugin-9h8shc4d.js:8-15,101-126`：`dsh plugin` 调 pnpm 后只协调
  bundle 清单。
- `@deepseek-ai/dsh/lib/profile-boot-DG5t9aNs.js:166-197`：bundle patches 在启动组合阶段生成。
- 同文件 `:241-273`：`composeLive()` 复用启动时的 `composed.bundlePatches`，watcher 只监听
  profile 与 home 两个用户 patch 文件。
