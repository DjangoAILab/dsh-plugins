# ops-ssh-manager — DSH 运维管理插件（v0.1.2 / Phase 1.5）

> 一句话：给 DSH 的 agent 加「受控 SSH 运维」能力——管理 html 页登记服务器/密钥，agent 只通过
> **代号**用 `ssh_exec` 执行命令，**私钥/密码永不进模型上下文**；对「严格」主机逐命令**阻塞审批**
>（允许一次 / 本 session 允许）。设计权威与迁移清单见 [`DESIGN.md`](DESIGN.md)；机制调研见
> [`knowledge/domains/ops-ssh-automation/`](../../../knowledge/domains/ops-ssh-automation/) 与
> [L0 审批/拦截/密钥隔离](../../../knowledge/foundations/tool-approval-interception-and-secrets.md)。
> 改编代码与设计参考的边界见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 1. 改了什么（原理与边界）

给 DSH 增加一个 bundle 插件（npm 包），两半：

**Host（`src/*.mjs`）**

- 注册模型工具 `ssh_exec`（按代号执行单条命令）与 `ssh_list_hosts`（列出代号/备注/审查等级）。
  模型**拿不到**主机地址、端口、私钥、密码，也**没有**任何「登记主机/改审查等级/导入密钥」的工具——
  执行权限与配置管理权限分离（借鉴 OneSSH）。
- 私钥/密码经 DSH `credentials` 服务存取（落盘 `$DSH_HOME/.credentials.yaml`），只在建立 SSH 连接
  那一刻 `resolve`，界面不回显、审计自动打码。
- 审查等级 `strict` 的主机：`ssh_exec` 内先查本 session 白名单，未批则经 `userQuestions.ask` 阻塞提问
  「允许一次 / 本 session 允许 / 拒绝」，拒绝即 fail-closed。
- TOFU 指纹：首次在管理页「测试连接」固定主机指纹，之后指纹变化拒绝连接；未固定指纹拒绝执行。
- 审计：每次 `ssh_exec` 与增删操作写 JSONL（`audit.jsonl`），敏感字段用 `***` 打码。
- 管理页 HTTP API（`/api/ops-ssh/*`）：roster 增删查、密钥导入/删除、测试连接、导入导出。

**Client（`client.js`）**

- 在 `settings.plugin.item` 槽位（插件配置区卡片，像 modlens 一样收口到「设置 → 插件」）注册「运维 SSH 管理」：
  主机列表/新增删除、密钥列表/导入私钥/删除、
  测试连接并固定指纹、导出（仅主机+公钥元数据）/导入。

**边界（明确不做 / 已知）**

- Phase 1 仅 `ssh_exec` 单命令（`exec` 通道），**无**交互 shell/PTY、无 upload/download（Phase 2）。
- 私钥**生成**未做（Phase 2，可走系统 `ssh-keygen`）；当前只支持**导入** OpenSSH/PEM 私钥。
- 私钥**不随配置导出**（安全设计）；迁移时私钥需在各机器重新导入。
- `/api/ops-ssh/*` 管理路由复用 DSH web 进程的既有信任边界（与 `dsh-file-upload` 同模式），**不独立鉴权**；
  只在 loopback 或 `connection.trustedHosts` 白名单 + 内网边界内有效。强认证（origin/CSRF 或独立反向代理）
  归 Phase 2，与本仓库 `web-remote-access` 的「暴露到更广网络必须先补认证层」结论一致。
- 审批依赖「精确 live runtime root」的人机边界（`userQuestions`）：只有真的人类会话能批准，subagent 会话
  不能（自动拒绝）。

## 2. 怎么生效

### 2.1 安装（bundle 插件，须重启 DSH）

```
# 生产 profile 必须 file:（机制见 L0 profile-plugin-dependency-resolution.md），勿用 link:
node "$HOME/.dsh/runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile <profile> add "file:$PWD/plugins/manual/ops-ssh-manager"
# 在安装副本中验证（源码目录不安装 peer/依赖）：
cd "$HOME/.dsh/profiles/web/node_modules/ops-ssh-manager"
node scripts/preflight.mjs && npm test
# 重启 DSH（交给用户或外部守护进程，别让承载当前会话的进程自我终止）
```

### 2.2 配置（全部可选，见 `cordis.patch.yml`）

```yaml
ops-ssh-manager:
  dataDir: ''     # 留空 = $DSH_HOME/ops-ssh-manager
  auditLog: ''    # 留空 = <dataDir>/audit.jsonl
```

### 2.3 使用

1. 打开「设置 → 插件 → 运维 SSH 管理」：先「导入私钥」；再「新增主机」（填代号/地址/用户/认证方式/审查等级），
  点「测试连接并获取指纹」→「保存主机」。
2. 在会话里让模型先调 `ssh_list_hosts`（返回 `sudo` 模式），再 `ssh_exec(code=…, command=…)`；
   需要 root 时传 `elevate: true`（命令本体不带 sudo）。提权走两阶段协议：免密机器直接执行，
   密码机器由插件注入登记的 sudo 密码（单次尝试，绝不重试）。
3. 把某主机 `review` 设为 `strict` 后，所有命令都会弹审批（允许一次 / 本 session 允许 / 拒绝）；
   提权请求即使主机是 normal 也会单独弹提权审批，两种「本 session 允许」相互独立。
4. 存量数据迁移（v1 → v2，一次性）：`node scripts/migrate-roster-v2.mjs`（dataDir 留空即默认
   `$DSH_HOME/ops-ssh-manager`），然后重启 DSH。

### 2.4 验证

```
node scripts/preflight.mjs && npm test   # import 预检 + 纯逻辑单测（schema/policy/sudo/audit/store）
# 装完重启后：管理页能列出/增删主机与密钥；ssh_list_hosts 返回代号与 sudo 模式；ssh_exec 跑只读命令；
# 把某主机标 strict 后 ssh_exec 会弹审批；elevate:true 在免密机器直接执行、密码机器注入执行；
# 命令里裸写 sudo 会被拒绝；管理页「测试 sudo / 验证 sudo 密码」可用。
```

## 3. 怎么回滚

```
npx -y @deepseek-ai/dsh plugin --profile web remove ops-ssh-manager
# 重启 DSH
```

回滚不影响已落盘数据：`roster.json` / `audit.jsonl` 与 `credentials` 里的私钥仍在原位，
重装即恢复管理面。要彻底清除，删 `<dataDir>/roster.json`、`audit.jsonl` 并 `unset` 对应
`OPSSSH_KEY_*` / `OPSSSH_PASS_*` / `OPSSSH_SUDO_*` 凭据。

**版本降级注意**：v2 插件落地的 roster 是 version 2 结构；若降回 Phase 1 旧版插件，旧代码会在下次
保存时把 version 写回 1（sudo 字段保留）。降级后如需再升回，重跑迁移脚本即可（幂等）。

## 4. 集成踩坑 / 已知降级

- `ssh_exec` 仅新连接、无连接复用（Phase 1 每次建连；`ssh2` 连接池留 Phase 2）。
- **带 passphrase 的私钥暂不支持**（Phase 1 只导入/使用无口令私钥；带口令的 key 会导入报错，
  连接也无从注入 passphrase）。Phase 2 补 key 口令字段。
- **Sudo 提权（Phase 1.5）**：`ssh_exec` 增加 `elevate: true` 参数（命令本体不要写 sudo，插件统一
  以 `/bin/sh -c` 包裹并加提权前缀 + 内层执行标记；命令含 sudo/su/doas 而未声明 elevate 会被
  fail-closed 拒绝）。主机级 sudo 配置为
  「两个框」：启用开关 + sudo 密码（可留空），对应 `sudo: none|auto|password`。提权审批与主机
  审批相互独立（`sessionApprovals` 双键）。sudo 密码经 credentials（`OPSSSH_SUDO_*`）在执行瞬间
  以一行 stdin 注入 `sudo -S`，不进命令串/上下文/审计/错误信息。协议与实测证据见
  [`DESIGN.md` §11](DESIGN.md)。
- **roster v2（无向前兼容）**：`roster.json` 升版本 2，每台主机必须有 `sudo` 字段；旧文件先跑
  `node scripts/migrate-roster-v2.mjs [dataDir]`（一次性，自动补 `sudo:'auto'` 并留 `roster.v1.bak.json` 备份；
  幂等可重跑），运行时对 v1 结构直接报错。
- 凭据 ref 是 **hex 编码**（`OPSSSH_KEY_<hex(keyId)>` / `OPSSSH_PASS_<hex(code)>` / `OPSSSH_SUDO_<hex(code)>`），避免 `-`/`.` 等字符碰撞。
- **sudo 两阶段协议的已知限制**：密码路径下命令本体拿到的是 EOF stdin（密码行被 sudo 消费），
  需要读 stdin 的命令（`sudo cat` 等）请由模型用重定向改写；探测分支以 exit code 驱动
  （stderr 文案随远端 locale 变化，只做提示）。
- 密码认证主机：密码存 `credentials`（`OPSSSH_PASS_*`），不在 roster 里；密钥认证同理（`OPSSSH_KEY_*`，
  `keyId` 指该凭据）。删除被引用的密钥会返回 409 防护。
- **审计的 command/输出按原样落盘（审计功能所需）**：命令文本里内嵌的明文凭据（如 `Authorization: Bearer …`）
  不会被 `redact` 打码，属已知取舍。
- **「本 session 批准」在插件纤维重挂 / DSH 重载时重置**（fail-closed），不是持久授权。
- 主机指纹以 `ssh2` 的 `hostHash:'sha256'` 保存，**是 hex 字符串**（64 个十六进制字符，不是 base64），
  与 `ssh -o FingerprintHash=sha256` 的 base64 输出是两种编码，不能直接比对。
