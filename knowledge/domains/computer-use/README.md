# computer-use — 浏览器 / 电脑操控（L1 领域知识）

> 领域范围：DSH 通过插件**操作浏览器本身**，以及由此延伸的 computer use（远程/本机 GUI 操控）。
> 核心对象是「让 agent 看见并操作一个图形界面」这整条链路 —— 观察什么（DOM/可访问性树 vs 截图）、
> 控制谁（本机已登录会话 vs 托管/远程沙箱）、以及把这件事**做成工具**还是**拆成子任务**。
> 调研时间：2026-08。

## 什么时候读

- 要评估/选型「让 DSH 操作浏览器 / 做 computer use / 未来做远程或本机 GUI 控制」的方案之前。
- 要判断「操作浏览器该做成一个工具，还是派子 agent / 子任务拆上下文」时。
- 已选定某条路线、要落地写插件之前（先看本目录的对比与缺口，再看 DSH 原语，再动手）。

## 涉及 DSH 机制时的权威事实（L0，必读、别复制）

浏览器/电脑操控最终落点仍是 DSH 的既有原语，属于 L0 不可变机制，不在本目录重写：

- 工具契约（注册/单次 JSON 值/协作式取消）与异步原语（jobs 轮询 / subagent settlement notice 推送）：
  `../../foundations/tool-async-and-callback-contract.md`
- 工具审批 / 拦截 / 密钥隔离（`tools/pre-execute`、`approval`、`guard`、`credentials`、
  `userQuestions.ask` 的 DELEGATED_CALLER 限制）：
  `../../foundations/tool-approval-interception-and-secrets.md`
- 「操作浏览器是否需要人批准（点击/表单/登录/2FA）」这类问题，答案先查上面那篇，别自造审批状态机。

## 分级信源体系（本目录 single source of truth）

本目录所有事实一律标注来源等级，标注规则如下；别处引用本目录事实时**保留等级标签，不要升级或降级**：

| 等级 | 名称 | 判定标准 | 可用于 |
| --- | --- | --- | --- |
| **L0** | 一手证据（primary） | 官方文档原文、项目源码/README 原文、论文原文 | 断言「机制是什么」这类事实 |
| **L1** | 权威二手（authoritative secondary） | 官方工程/产品博客、权威综述论文、厂商正式说明 | 断言「业界共识/官方取向」 |
| **L2** | 社区实测（community empirical） | 成熟开源项目 metadata + 发布记录、开发者实测博文、社区踩坑 | 断言「社区做法/经验值」 |
| **L3** | 传闻/待核实（unverified） | 单方说法、标题党、无出处转述 | 仅作线索，采信必标「待核实」 |

> 用 L3 的代价是可信度，本目录原则上只把它当「进一步核实线索」。

## 目录树即索引

本目录下各文件 `ls` 即可见全，本 README 不罗列内容清单；每个文件正文里的事实都带上述等级标签。
