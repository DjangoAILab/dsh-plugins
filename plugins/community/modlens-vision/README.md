# modlens-vision — 为纯文本模型接入视觉

本目录记录第三方插件 [modlens](https://github.com/liustack/modlens) 的公开集成配方。源码由上游维护，
本仓库不 vendor npm 包。需要让 DSH 的纯文本模型读取图片，或排查 modlens 的安装、配置和回滚时读本文。

## 改了什么

modlens 可以把图片交给独立的视觉模型分析，再把 OCR、布局和语义等文本证据回填给原来的文本模型。
它支持工具式 `modlens_read_image`，也能为部分文本模型提供自动转换图片的视觉包装条目。

这里采用通用的 OpenAI-compatible 多模态端点示例。端点、模型 ID 和 API key 都必须由部署者提供；
仓库不包含真实服务地址、凭据或私有模型别名。

## 怎么生效

把版本写死安装到目标 profile：

```bash
npx -y @deepseek-ai/dsh plugin --profile <name> add @liustack/modlens@3.18.1
npx -y @deepseek-ai/dsh plugin --profile <name> list
```

modlens 配置落在 `$HOME/.modlens/config.json`。以下命令通过隐藏输入设置独立凭据，不把 key 写进 shell
历史或仓库：

```bash
MODLENS="$HOME/.dsh/profiles/<name>/node_modules/@liustack/modlens/dist/main.js"
read -r -s -p "Vision API key: " VISION_API_KEY; echo

node "$MODLENS" config set openai.baseUrl "https://api.example.com/v1"
node "$MODLENS" config set openai.model "<vision-model-id>"
printf '%s' "$VISION_API_KEY" | node "$MODLENS" config set openai.apiKey
node "$MODLENS" config set provider openai
node "$MODLENS" config set openai.structuredOutput true
unset VISION_API_KEY
```

验证配置和一次真实图片分析：

```bash
node "$MODLENS" doctor
node "$MODLENS" analyze -i <image-path> -p openai
```

bundle 插件安装或版本变化后需要冷启动 DSH。由用户、服务管理器或外部守护进程执行重启和健康检查，
不要让承载当前会话的 DSH 进程自行终止。

## 怎么回滚

```bash
npx -y @deepseek-ai/dsh plugin --profile <name> remove @liustack/modlens
```

若还要删除独立的视觉配置，可在确认不再被其他 profile 使用后移除 `$HOME/.modlens/config.json`。

## 集成踩坑记录

- `openai.baseUrl` 通常写到 `/v1`，不要把 `/chat/completions` 重复写入；modlens provider 会自行拼接接口路径。
- API key 只从独立安全输入或环境变量注入，不复用、读取其他 CLI 的私有配置。
- OpenAI-compatible 只是接口形态声明，不代表端点完整支持图片、流式事件或结构化输出；上线前必须对目标
  服务分别做端到端验证。
- 小型视觉模型可能生成不合法 JSON。端点支持 `response_format` 时可开启 `structuredOutput`，仍需实测
  目标模型是否正确遵守 schema。
- 安装成功不等于当前 DSH 进程已加载新 bundle；加载边界见
  [`plugin-loading-and-hot-reload`](../../../knowledge/foundations/plugin-loading-and-hot-reload.md)。
- 远程访问设置页出现 403 时，先核对 DSH 的 loopback-only 配置面边界，见
  [`loopback-only-config-surface`](../../../knowledge/foundations/loopback-only-config-surface.md)。
