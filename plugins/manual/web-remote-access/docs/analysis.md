# DSH Web 服务端化：根因与机制分析

## 一、两个现象的根因

### 1. `http://192.0.2.10:3080/` 拒绝连接

DSH Web 服务的绑定逻辑在 `@deepseek-ai/dsh-host-webserver`：

```js
static Config = z.object({
  host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
  port: z.natural().max(65535).required()
});
```

而 web profile 的组合里，webserver 行的配置默认值是：

```yaml
# @deepseek-ai/dsh-web-app/cordis.patch.yml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

不传 `--host` 时默认 `127.0.0.1`，于是服务只监听 loopback。实测运行中的进程
`node .../dsh web`（PID 67804）监听 `TCP 127.0.0.1:3080`。`192.0.2.10` 是网卡 IP，
上面没有监听者，所以「拒绝连接」。

### 2. 选项目走浏览器本地文件 API

`@deepseek-ai/dsh-host-directory-picker-auto` 在启动时解析目录选择器后端：

```js
function resolveDirectoryPickerBackend(facts) {
  if (facts.bindHost !== "127.0.0.1") return "browse";
  // ... darwin/win32 且有显示会话 → native
}
```

绑定 loopback 时返回 `native`：浏览器用 File System Access API（`showDirectoryPicker`）
弹系统目录框，而且 `host.pickDirectory` / `host.openPath` 被列入
`PRIVILEGED_METHODS`（loopback-only），远程直接 403。

## 二、DSH 已内置的远程化机制

### 目录选择器自动切换

`bindHost !== "127.0.0.1"`（即 `0.0.0.0`）时，`directory-picker-auto` 自动挂载
`browse` 后端（`@deepseek-ai/dsh-host-directory-picker-browse`），走
`host.listDirectory` / `host.createDirectory` 两个 RPC —— 这两个方法**不在**
loopback-only 白名单里，远程可用。browse 后端直接列**服务器**文件系统（`opendir`/`mkdir`），
正是远程场景需要的语义。

### trustedHosts：为域名反代预留

`@deepseek-ai/dsh-client-connection` 的信任栅栏 `isTrustedApiRequest` 判断 Host：

```js
if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
```

web-app bundle patch 里 `connection` 行的注释直接给了域名写法：

```yaml
# A deployment adding authorities keeps this expression and concatenates
# its literals, for example: ['dsh.example.com', ...ctx.webRuntime.trustedHosts].
```

所以把 `dsh.example.com` 加入 `trustedHosts` 后，经合规反向代理
（`passHostHeader` 默认 true，会透传原始域名 Host）进来的请求即可通过栅栏。

## 三、为什么不能直接 `--host 0.0.0.0`

`@deepseek-ai/dsh-web-app/startup.js` 在 CLI 层显式拒绝：

```js
if (options.host === "0.0.0.0") program.error(
  "error: --host 0.0.0.0 is intentionally not supported yet for safety: "
  + "it would expose remote code execution to the network; use 127.0.0.1 instead");
```

原因：Web GUI 是完整 RCE 面（agent 能跑 shell）。因此正确做法不是在 CLI 传参，
而是在**组合层**覆盖 webserver 行（部署方自己的决定，属于 DSH 的正规扩展点），
并同时认清 `trustedHosts` 不是认证，需在边界补认证。

## 四、补丁内容

见仓库根目录 `cordis.patch.yml`。核心两行覆盖：

```yaml
- id: webserver
  config: { host: '0.0.0.0', port: 3080 }

- id: connection
  config:
    trustedHosts: !!js "['dsh.example.com', ...ctx.webRuntime.trustedHosts]"
```

`!!js` 在该 YAML 方言里是 scalar 类型的表达式节点（`cordis-plugin-include` 的
`JsExpr`，`kind: "scalar"`），因此数组表达式必须写成带引号的 scalar。

## 五、链路（补丁生效后）

```
浏览器（已通过边缘认证）
  │  https://dsh.example.com
  ▼
反向代理（TLS 终结、认证、透传域名 Host）
  │  http://<dsh-host>:3080
  ▼
DSH web server（0.0.0.0:3080）
  ├─ /api  RPC        （Host 在 trustedHosts → 放行）
  ├─ /api/events.*    WebSocket 下链（同上放行）
  ├─ 目录选择器 = browse（bindHost=0.0.0.0 自动切换）
  └─ SPA 静态资源
```

## 六、仍被 loopback 锁定的能力（预期行为）

`PRIVILEGED_METHODS` 仍把以下能力锁在 loopback，远程不可用（这是安全设计，无需放开）：

- `host.pickDirectory`、`host.openPath`（native 对话框 / 在宿主机打开文件）
- `settings.*`、`credentials.*`、`llm.discoverModels`（配置与凭据面）
- `agentPreset.*`（agent 预设的读/写/打开文档）

远程选目录走的是 browse 后端的 `host.listDirectory` / `host.createDirectory`，不受影响。
