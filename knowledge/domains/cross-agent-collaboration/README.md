# cross-agent-collaboration — 跨 Agent 协作（L1 领域知识）

> 领域范围：DSH 作为 orchestrator，把**外部** Agent（Codex CLI、Claude Code、OpenCode、Gemini CLI、
> CodeBuddy…）以「工具 / 子 agent」的方式调起来，尤其「异步 + 回call」这条主线，以及它背后的社区
> 实现、协议标准、缺口与推荐落地路径。

## 什么时候读

- 要让 DSH 调外部 agent 当工具（同步或异步）之前。
- 要评估 / 选型「A2A / MCP Tasks / ACP / Claude Agent SDK / Codex SDK / codex-as-mcp」等方案时。
- 要在本领域写新 runbook 或实现外部 agent provider 之前，先读这里的调研与缺口。

## 涉及 DSH 机制时的权威事实

这不是本目录的内容——工具契约、jobs（轮询）、subagent provider 缝隙 + settlement notice（推送）、
subprocess 进程原语，都属于 L0 不可变机制，见
`knowledge/foundations/tool-async-and-callback-contract.md`（涉及即读，别处引用、不复制）。

## 目录树即索引

调研文档、后续的选型/runbook 都放在本目录下各自文件里，`ls` 即可看到全部，本 README 不罗列。
