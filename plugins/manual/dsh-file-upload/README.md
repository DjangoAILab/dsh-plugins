# dsh-file-upload —— 本地手搓文件上传插件（流式 + 文件卡片 + 预览下载）

> 一句话：把文件/图片传进 DSH 对话，统一「视作文件」落盘、路径进上下文交给 agent 自己调
> 工具处理；聊天历史里渲染成 DeepSeek 风格文件卡片，可预览/下载，图片内联预览。
> 基于 MIT 的 [a903067276-rgb/dsh-file-upload](https://github.com/a903067276-rgb/dsh-file-upload) 手搓改造。

## 何时读本文件

- 要重新安装 / 升级 / 回滚这个上传插件时。
- 要调整上传大小上限、落盘位置、文件卡片样式时。
- 要排查「上传按钮没出现 / 历史消息文件卡片不渲染 / 与识图插件冲突」时。

## 1. 改了什么（相对上游 a903067276-rgb/dsh-file-upload）

| 改动 | 上游 | 本插件 |
| --- | --- | --- |
| 上传传输 | base64（前端 25MB / host 30MB 硬限制） | **流式 body**，突破到默认 1GiB/文件（可配） |
| 文件读取 | 无（只有落盘） | 新增 GET /api/file-upload/content（预览/下载） |
| 历史消息展示 | 只插一行路径文本，无卡片 | 接管 user 渲染器，渲染**文件卡片**（图标/缩略图 + 名 + 大小 + 预览 + 下载） |
| 图片 | 无内联预览 | 图片卡片内联 <img> 预览 |
| 与识图插件 | vision-plugin agnostic（路径文本） | 保持一致：路径进上下文，agent 用 modlens_read_image 读；UI 预览走自研 URL，不碰原生附件管线 |

设计原则（用户定）：**轻量、单一、独立**——只做「把文件落盘 + 路径给 agent + 渲染卡片」，
不做任何内容提取 / OCR / 转 Markdown；不拦截粘贴图片（粘贴仍走 DSH 原生缩略图）。

## 2. 怎么生效

### 安装（本地 link）

    npx -y @deepseek-ai/dsh plugin --profile web add "link:$PWD/plugins/manual/dsh-file-upload"
    npx -y @deepseek-ai/dsh plugin --profile web list   # 确认出现 dsh-file-upload-local

> bundle 插件，**装完必须重启 DSH** 才加载（依据见
> knowledge/foundations/plugin-loading-and-hot-reload.md）。重启由守护进程/用户执行，别在 agent 会话里自 kill。

### 使用

1. 输入框工具行出现「📎 文件」按钮，点击选文件/图片（可多选，不限制类型）。
2. 上传后草稿里插入四行标记（[附件]/[路径]/[大小]/[类型]），发送即可。
3. 模型拿到路径，自行调用 read / bash / modlens_read_image 处理。
4. 历史消息里该条渲染成文件卡片：图片内联缩略图 + 预览/下载，非图片图标 + 预览/下载。

### 上传大小上限（环境变量）

默认 1GiB/文件，可经 DSH_FILE_UPLOAD_MAX_BYTES（字节数）覆盖：

    DSH_FILE_UPLOAD_MAX_BYTES=5368709120  dsh web   # 5 GiB/文件

落盘位置：当前会话 cwd 下的 uploads/ 目录（agent 工作目录内，read/bash 直接可见）。

## 3. 怎么回滚

    npx -y @deepseek-ai/dsh plugin --profile web remove dsh-file-upload-local
    # 重启 DSH

## 4. 集成踩坑 / 已知降级（带证据）

- **单 entry 挂载**：cordis.patch.yml 只挂一条（host apply 与 client 半都走包加载）。双 entry 会让 host
  apply 跑两次，/api/file-upload/save 路由重复注册崩溃（依据：dsh-host-webserver 的 register 对重复
  (kind,path) 直接 throw）。
- **接管 user 渲染器**（conversation.chat.node key user priority -1）是渲染文件卡片的唯一正道；代价是
  必须复刻产品 user 气泡。当前复刻：原生图片画廊（复用 ImageGallery）+ 纯文本（复用 MessageText）。
  已知降级：/skill @subagent 的 refChip 高亮、消息「复制」按钮暂未复刻（不影响读写，仅视觉）。
- **图片分流**：只有「📎 文件」按钮选的图片走本插件的文件管线；粘贴/拖拽图片仍走 DSH 原生附件
  （缩略图 gallery + lightbox），与已装 modlens 零冲突（两条路互不干扰）。
- **大小限制为什么能突破**：DSH 的 webServer 直接把原始 IncomingMessage 交给路由 handler，不预读、
  不设全局 body 上限（见 @deepseek-ai/dsh-host-webserver/lib/index.js 的 createServer），所以流式落盘可行。
