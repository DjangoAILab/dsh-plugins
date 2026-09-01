# settings-plugin-card-namespace — 「插件配置区」卡片按 settings 命名空间派发

> 一句话：DSH「设置 → 插件 → 插件配置」里的卡片，**key 是 settings 命名空间**，不是插件名。
> 一个 bundle 插件要在这里出现一张自己的卡片，必须**在 Host 侧 `settings` 服务注册一个命名空间**，
> 再在 Client 侧用**同名 key** 往 `settings.plugin.item` 槽位注册卡片组件。漏了前者，卡片永远不会被派发。

## 事实

证据来自 `@deepseek-ai/dsh-client-ui-settings-plugins`（runtime 0.1.0-rc.7）与 `@deepseek-ai/dsh-settings`：

- 配置区 tab（`ConfigurablePluginsTab`）渲染的是**两个账本的交集**：
  1. Host 服务的命名空间（通过 `api.settings.describe({})` 读到的 `settings.register` 结果）；
  2. 注册到 `settings.plugin.item` 槽位的卡片（key = 命名空间）。
- 派发代码：`namespaces.map((ns) => renderSlot("settings.plugin.item", {}, { entryKey: ns }))`。
  → 卡片 key 必须等于 Host 已注册的 settings 命名空间字符串，否则「Host 不 serve 该命名空间」就不派发。

## 落地两步

1. **Host**：`installSettingsSection(ctx, settingsNamespace('ops-ssh-manager'), z.object({...}), entry, { setSource, onChange })`
   —— 它内部 `ctx.inject(['settings'], …) => settings.register(ns, schema, { base: entry })`，把命名空间挂进
   settings 服务（可选注入，没 settings 服务时不注册），并随 fiber 生命周期回收。
   schema 用 `@deepseek-ai/schemastery` 的 `z`（`z.string().default('')`、`z.object({...})` 等）。
2. **Client**：`slots.inject('settings.plugin.item', () => slots.register({ name: 'settings.plugin.item', key: 'ops-ssh-manager' }, Card))`
   —— key 与 Host 命名空间一致。

## 何时读

- 给 bundle 插件加「插件配置区自己的卡片/页」时（而不是顶层 `settings.section`）。
- 排查「卡片/插件没出现在『设置 → 插件』」时，先查 Host 是否 `settings.register` 了对应命名空间。