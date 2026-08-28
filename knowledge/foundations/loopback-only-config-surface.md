# loopback-only-config-surface — DSH 配置面只接受回环来源

## 事实（不可变机制）

DSH 的**整个配置面**（`settings.*` 与 `credentials.*` RPC 方法，即 Web GUI 里的
「设置 → 模型 / 插件 / 凭据」等页面）被硬编码为 **loopback-only**：只有来自
`127.0.0.1`（回环）的同源请求才会被放行，从局域网 IP 或域名访问一律 `403 Forbidden`。

会话域（`session.models` / `selectModel`）**不在**这个特权集合里，所以模型选择器与
聊天/读图可以远程用，唯独「设置」类页面远程 403。

## 证据

**官方源码说明**（`dsh-host-apiproxy` README，配置面协议一节）：

> 浏览器载体把整个配置面（含读取与原生操作：`settings.describe`/`openDocument`/`update`/
> `replace`/`mutate` 与 `credentials.describe`/`set`/`unset`）限制为**仅接受来自回环地址的
> 同源请求**——即 `host.pickDirectory` 所在的特权集合。……仅新增一项 Settings 注册，绝不会
> 使其可被远程读取或写入。

**实测复现**：

```
POST http://127.0.0.1:3080/api/settings.describe        → 200
POST http://192.0.2.10:3080/api/settings.describe    → 403 forbidden  # 文档示例地址
```

## 为什么安全边界这样设计

配置面可以改 API key、改路由、读写凭据，等于给访问者「配置整个 DSH」的能力，所以只允许
本机回环操作。`connection.trustedHosts` 只做 DNS-rebinding 防伪（校验 Host 头），
**不**放开这条回环来源校验——两者是两回事，别指望靠 trustedHosts 打开它。

## 处理方式（无需、也不该改配置放开）

- **本机改设置**：在 Mac 上直接开 `http://127.0.0.1:3080`。
- **远程改设置**：用 SSH 隧道把回环地址带到本地（服务端看到的来源是 127.0.0.1）：
  ```bash
  ssh -L 3080:127.0.0.1:3080 <user>@<dsh-host>
  # 本地浏览器开 http://127.0.0.1:3080
  ```
- 需要程序化改配置时，直接用 CLI 写落盘文件（如 `modlens config set` 写
  `~/.modlens/config.json`），与 Web 配置卡片写的是同一份文件。
