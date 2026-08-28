# web-remote-access（DSH Web 服务端化）

> 所属插件库：[`dsh-plugins`](../../../README.md) · 模块路径：`plugins/manual/web-remote-access`

把 DeepSeek Harness（DSH）的 Web GUI 从「仅本机 loopback 访问」扩展成「可通过受保护域名访问」的服务端应用。

## 背景与根因

DSH 的 `dsh web` 默认把 HTTP 服务绑定在 `127.0.0.1:3080`，因此：

1. **`http://192.0.2.10:3080` 拒绝连接** —— 网卡 IP 上没有任何进程监听，只有 loopback。
2. **选项目走浏览器本地文件 API** —— 绑定在 loopback 时，`dsh-host-directory-picker-auto` 挂载
   `native` 后端（浏览器 File System Access API），它只在「浏览器与服务同机」时才有意义。

DSH 已经内置了远程化的全部开关，本模块只是把它们打开：

- webserver 的 schema 本就接受 `0.0.0.0`；
- 一旦 `host !== 127.0.0.1`，目录选择器**自动**切到 `browse` 后端（浏览器内逐级列服务器目录）；
- `connection.trustedHosts` 就是为「域名反代」预留的 DNS-rebinding 白名单。

详见 [`docs/analysis.md`](docs/analysis.md)。

## 改了什么

### 文件

- `cordis.patch.yml` —— 组合补丁，应用到 `$DSH_HOME/profiles/web/cordis.patch.yml`
- `daemon/` —— 守护进程、自启配置与重启前 bundle 预检（macOS launchd + Linux systemd 模板）
- `docs/analysis.md` —— 根因与 DSH 核心机制分析

## 怎么生效

### 应用补丁

补丁的目标文件是 DSH web profile 的用户层：

```
$DSH_HOME/profiles/web/cordis.patch.yml
```

把本仓库 `cordis.patch.yml` 的内容合并进去即可（该文件本来就是给用户覆盖用的，
DSH 启动时按 `base → dsh-web-app bundle patch → 用户层 → --patch` 的顺序叠加）。

验证补丁是否生效（不启动服务、不影响运行中的实例）：

```bash
dsh --profile web --dump-config --patch cordis.patch.yml | grep -A6 "id: webserver"
# 期望看到: host: 0.0.0.0
```

### 配置受保护的反向代理域名

在你自己的 Nginx、Caddy、Traefik 或云隧道中，把 `https://dsh.example.com` 代理到
`http://<dsh-host>:3080`，并保留原始 `Host` 头。随后把同一个域名写入
`cordis.patch.yml` 的 `trustedHosts`。这里不绑定任何特定组织的路由管理服务。

### 守护与自启

> ⚠️ 不要在「agent 会话里」重启 dsh web：agent 本身就运行在 dsh web 进程内，
> 重启它就是自杀。正确做法是交给外部守护进程（launchd/systemd）托管，由它杀旧拉新。

### macOS（本机）— launchd

```bash
# 安装锁定运行时后加载服务（自动 RunAtLoad + KeepAlive）
bash daemon/install.sh

# 日常操作
bash daemon/status.sh    # 查看状态与监听
bash daemon/preflight.sh # 不停服务，预检 profile 组合与树外 bundle 入口
bash daemon/restart.sh   # 预检通过后安全重启（launchctl kickstart -k）
bash daemon/uninstall.sh # 卸载（不删日志与补丁）
```

日志：`$HOME/.dsh/dsh-web.log`。

服务运行时不再引用共享的 `~/.npm/_npx/` 缓存。版本由
`daemon/runtime-package.json` 精确指定，完整传递依赖由
`daemon/runtime-package-lock.json` 锁定；安装脚本先在临时目录执行 `npm ci` 和 CLI
校验，再把 `$DSH_HOME/runtime/current` 原子切换到新运行时，最后以 HTTP 200 作为成功门禁。
因此并发执行 `npm exec @deepseek-ai/dsh plugin ...` 不会再改写正在运行的服务代码。

`restart.sh` 会先运行 `preflight.sh`。预检在不停止当前服务的前提下执行 `--dump-config`，并
逐一导入 profile 中所有树外 bundle 的 Node 入口；缺 peer、入口语法错误或包解析失败时立即
退出，不会执行 `launchctl kickstart -k`。这道门禁覆盖本机 2026-08-18 的
`ERR_MODULE_NOT_FOUND` 事故类型，但不能代替启动后的 HTTP 健康检查，也不能证明插件
`apply()` 阶段绝不会失败。

**从「前台进程」切到守护**：先在你跑 `npx @deepseek-ai/dsh web` 的终端按 `Ctrl+C`
停掉前台实例，再执行 `bash daemon/install.sh`（否则 3080 被占用会安装失败）。

**版本维护**：升级 DSH 时，把 `daemon/runtime-package.json` 中的版本改成经 npm registry
确认的精确版本，重新生成 `daemon/runtime-package-lock.json`，再执行 `daemon/install.sh`。
升级 node（nvm）时仍需同步更新 plist 与脚本中的 `NODE_BIN` / `NPM_BIN` / `PATH`。

### Linux — systemd 用户单元

用 `daemon/dsh-web.service` 模板（改路径后放到 `~/.config/systemd/user/`）：

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-web
sudo loginctl enable-linger <用户名>   # 开机自启（不要求登录）
```

### 其他环境

- **Docker**：把 `dsh`、`~/.dsh`（profile + 补丁 + sessions）挂进容器，暴露 3080，用 `restart: unless-stopped` 自启。
- **Windows**：用 NSSM 或任务计划程序（登录时触发）托管同样的 `dsh web` 命令。

## 怎么回滚

把 `cordis.patch.yml` 里对 `webserver` / `connection` 两行的覆盖删掉（或整个清空），
再 `bash daemon/restart.sh`（守护方式）即回到 loopback-only。

若要回滚 DSH 运行时，把 `daemon/runtime-package.json` 改为目标精确版本、重新生成锁文件，
再执行 `daemon/install.sh`。安装脚本只有在新进程通过 HTTP 探测后才清理上一版运行时；探测
失败会尝试恢复原运行时与 launchd 配置。

## 安全提示

DSH Web GUI 是完整的远程代码执行面（agent 能运行 shell、改文件）。`trustedHosts`
只是 DNS-rebinding 防伪，**不是认证**。无论服务位于局域网还是公网，都必须在反向代理处
补认证层，可选：

1. Traefik/Caddy/Nginx 边缘的 `basicAuth`、OIDC 或 `forwardAuth`；
2. 登录页 + 短期 HMAC token 的 DSH 插件；
3. 在 DSH 前放一个独立认证反向代理进程。
