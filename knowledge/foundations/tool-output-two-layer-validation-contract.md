# 工具输出两层校验契约（L0 基础事实）

## 是什么 / 为什么

DSH 工具（plugin 注册的 model-visible tool）的返回值要过**两层彼此独立的校验**，任何一层
不过 = 整个工具调用失败。写插件 execute() 时若不知道这两层，会用「undefined 占位可选字段」
「null 塞进 string 字段」「展开上游对象」这类写法埋雷——2026-08-31 dsh-computer-use 的
4 个现场故障里 3 个直接源于此（一手证据见文末）。

## L1：output schema 校验（dsh-tools）

- 位置：`@deepseek-ai/dsh-tools` 的 `lib/types/json-schema.js`（`validateJsonSchemaValue`）。
- enforced 子集：`type` 只接受**单字符串**（type 数组直接报
  `type arrays are not supported`，244-247 行）；关键字仅
  `type/oneOf/properties/required/additionalProperties/items/enum/const`。
- `additionalProperties: false` 时**任何一个未声明键 = 整体拒绝**（495 行
  `is not a declared property`）。
- `null` 是合法 JSON 值，但**不匹配** `type:"string"/"number"`（无 null 联合语义；
  要表达 nullable 只能 `oneOf`，插件实践上首选在 JS 边界把 null 归一化删键）。

## L2：lossless JSON（run_code / Code Mode 消费者）

- 位置：`@deepseek-ai/dsh-code-runtime-worker-thread` 的 `worker.cjs`
  `snapshotCodeJsonValue`（342 行拒非有限数字，346 行拒非 object 类型）。
- 结果树里**任何位置**出现 `undefined` 属性值、`NaN`、`Infinity` → 整个绑定调用失败，
  报 `not lossless JSON`。普通模型调用路径序列化时静默丢弃 undefined 键，所以这条
  **只在 run_code 消费时炸**——同一个 bug 两种报错形态，极易误判为「时好时坏」。

## 插件侧实践约定（从本轮修复沉淀）

1. 可选字段一律**条件性展开**（`...(x ? { x } : {})`），禁止 `{ x: undefined }` 占位。
2. 上游（driver/外部 API）应答**不要原样展开**进 execute 返回值；显式挑字段。
3. nullable 一律在 JS 边界归一化删键，schema 保持纯类型可选；schema 不用 oneOf-null。
4. 测试必须用 `validateJsonSchemaValue` 对 execute 真实输出断言（渲染函数单测测不出
   execute 的形状漂移）；外加一棵 undefined 树遍历。

## 一手证据（L0，2026-08-31 dsh-computer-use 实测）

- `computer_snapshot`：execute 展开 driver 应答 + `_lines` 未声明 →
  `"value.nodes"/"value.frame"/"value.title"/"value._lines" is not a declared property`。
- `computer_list_apps`：driver 输出 `hidden` 未声明 →
  `value.apps[N].hidden is not a declared property`；同型 `bundleId:null`/`axWindows:null`
  对 string/number 的冲突在 AX 未授权时必炸（null 不匹配声明类型）。
- `computer_windows`：`{ windows, hint: undefined }` → run_code 路径
  `value must be a lossless JSON object`（同参数模型路径正常，实锤两层差异）。
- `computer_doctor`：失败分支返回未声明的 `reason` + `frontApp: undefined` → 两层各炸一次。
- 修复与回归防线：`plugins/manual/dsh-computer-use` v0.1.1（test/tools-schema.test.mjs
  用 stub driver + validator 对每个工具 execute 全量断言，自动枚举防漏测）。
