# profile-plugin-dependency-resolution — DSH profile 插件的依赖解析边界

## 事实

DSH 把树外 bundle 安装在 `$DSH_HOME/profiles/<profile>/node_modules`，并维护一个共享的
`$DSH_HOME/profiles/node_modules` fallback。fallback 将 DSH 应用完整依赖闭包中的包链接到
固定运行时，使树外插件可以把 DSH Service Definition / Service Provider 包声明为 peer，
而不必各自安装一份宿主核心包。

本地生产 bundle 如果要导入这些宿主 peer，应使用 `file:/absolute/path` 安装；不要使用
`link:/absolute/path`。`file:` 会把包物化到 profile 的安装树，Node 沿父目录查找时能够到达
共享 fallback。`link:` 的包入口会按真实仓库路径执行；Node 默认跟随 symlink 后从仓库目录
向上查找，因而跳出 profile 树，可能在冷启动时报 `ERR_MODULE_NOT_FOUND`。

这只约束本地包的依赖解析方式。bundle 安装后的激活边界见
[plugin-loading-and-hot-reload](plugin-loading-and-hot-reload.md)。

## 代码证据（`@deepseek-ai/dsh@0.1.0-rc.7`）

- `@deepseek-ai/dsh-app-boot/lib/index.js:390-438` 的 `healProfilesModuleFallback()` 明确创建
  `$DSH_HOME/profiles/node_modules`，并遍历 DSH app 的 `dependencies` 与 `peerDependencies`
  闭包建立 symlink。
- 同文件 `:394-402` 明确依赖 Node 的 parent-directory walk；也说明 symlinked package
  会从其真实目录解析自身依赖。
- `@deepseek-ai/dsh/README.zh.md:32-41` 说明树外插件由 pnpm 安装到 profile 自己的
  `node_modules`，bundle 先从 DSH 安装目录解析，再从 profile 安装树解析。

## 实测证据（2026-08-18）

`dsh-external-agents` 以 `link:` 注册时，`dsh plugin add` 返回 0，但 DSH 冷启动导入
`src/index.mjs` 时找不到 `@deepseek-ai/dsh-tool-subagent`，launchd 因退出码 1 进入 KeepAlive
循环。改用 `file:` 后，安装入口位于 `$DSH_HOME/profiles/web/node_modules/dsh-external-agents`，
以下离线入口探针通过，随后两次冷启动均返回 HTTP 200：

```bash
cd "$DSH_HOME/profiles/web"
node --input-type=module -e "await import('dsh-external-agents')"
```

生产安装命令：

```bash
dsh plugin --profile web add file:/absolute/path/to/plugin
```
