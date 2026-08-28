# dsh-web-mobile —— 移动端布局适配（本地化维护）

> 一句话：把第三方 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)
> 的源码拉进本仓库本地管理，方便后续改细节。它只做「窄屏布局」：把 DSH 桌面 UI 在手机
> 上（视口 ≤1023px）变成抽屉侧栏、全屏弹窗、不重叠的输入栏等；**桌面端零影响**。

## 何时读本文件

- 要重新安装 / 升级 / 回滚这个移动端布局插件时。
- 要在 src/ 里改移动端 CSS/交互后重新构建时。
- 只想看它到底改了哪些布局 → 读 UPSTREAM-README.md（原 README 全量功能清单）。

## 1. 来源与许可（本地化的边界）

- 上游：github:mexiaosqwq/dsh-web-mobile，tag v1.0.0。
- 许可证：**MIT**（版权 Copyright (c) 2026 mexiaosqwq），见 LICENSE 文件。
- 本仓库把 **source of truth 也落到这里**：src/（TS/TSX 源码）+ lib/（构建产物）+
  scripts/build-client.mjs（构建脚本）一起入库，跟 dsh plugin add github:... 装的版本等价，
  但改完源码可自行重构建、重新安装，不必再拉上游。

## 2. 改了什么 / 怎么生效

### 安装（本地 link，不再走 GitHub 源）

    npx -y @deepseek-ai/dsh plugin --profile web add "link:$PWD/plugins/manual/dsh-web-mobile"
    npx -y @deepseek-ai/dsh plugin --profile web list   # 确认出现 @dsh-external/dsh-mobile-nav

> 包名是 @dsh-external/dsh-mobile-nav（上游 package.json 的 name，cordis.patch.yml 内引用它，
> 不要改名）。bundle 插件，**装完必须重启 DSH** 才加载（依据见
> knowledge/foundations/plugin-loading-and-hot-reload.md）。

### 生效判定

重启后，手机（或把浏览器窗口缩到 ≤1023px）打开 DSH：侧栏变成抽屉、弹窗全屏居中、
输入栏权限胶囊与模型名不重叠、设置页单列，即生效。

### 改源码后重构建（可选）

    cd plugins/manual/dsh-web-mobile
    corepack enable && pnpm install
    pnpm run build            # tsc → build-client.mjs 打包成 lib/client.js

改完重新 dsh plugin add link:... 覆盖 + 重启。

## 3. 怎么回滚

    npx -y @deepseek-ai/dsh plugin --profile web remove @dsh-external/dsh-mobile-nav
    # 重启 DSH

## 4. 集成踩坑 / 注意

- **不在 npm，只能 GitHub 源或本地 link**。为了「本地可调」，本仓库采用本地 link 安装。
- **移动端与上传按钮的配合是待实测点**：它只重排布局，不新增 composer 工具行按钮；
  与本仓库另一个插件 dsh-file-upload（在 conversation.input.left 注入上传按钮）组合后，
  窄屏下该按钮是否被 CSS 挤掉需在真机/窄窗验证。若被挤掉，给 src/client/styles/ 补一条
  窄屏规则让按钮露出即可（改动点见下轮实测记录）。
- 纯 CSS/客户端插件，host 半是空的（src/index.ts 的 apply(): void {}），无落盘、无路由，不碰配置面。
