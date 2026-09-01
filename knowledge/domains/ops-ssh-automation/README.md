# ops-ssh-automation — L1 领域知识

## 这里放什么

给 agent 提供「受控 SSH 运维」能力（连接/密钥管理、代号隔离、逐命令审批、审计）相关的领域知识：
社区已有方案的盘点、可迁移设计清单、以及本仓库 `ops-ssh-manager` 插件的设计依据。凡「怎样安全地让 agent 操作
远程服务器」这条线上的经验与决策，都归这里。

## 什么时候读

- 设计、维护或评审 `plugins/manual/ops-ssh-manager`（或任何「agent + SSH」类插件）时。
- 需要判断「已有社区方案能借鉴什么，以及哪些代码需要保留许可证」时。
- 涉及 DSH 机制层面（审批、密钥隔离、拦截）时，先回看
  [L0 tool-approval-interception-and-secrets](../../foundations/tool-approval-interception-and-secrets.md)。

入口文档：[community-landscape-and-migrated-design.md](community-landscape-and-migrated-design.md)。
