// dsh-external-agents scripts/preflight.mjs
// 冷启动 import 预检（呼应 DESIGN.md §4 的 ERR_MODULE 健壮性定论）：
// 逐个 import 插件的宿主依赖与自身源文件，能在 bundle 冷启动前把缺包/语法错揪出来，
// 而不是等到 DSH 进程加载插件时才炸。
//
// 用法（在已安装 bundle 的位置，或本仓库内带 ./node_modules 链接时）：
//   node scripts/preflight.mjs
// 返回 0 = 全部通过；非 0 = 第一个失败的模块名 + 错误。

const MODULES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-jobs',
  '../src/route.mjs',
  '../src/tool.mjs',
  '../src/provider.mjs',
  '../src/index.mjs',
]

let failed = []
for (const mod of MODULES) {
  try {
    await import(mod)
    console.log('[ok] ' + mod)
  } catch (error) {
    failed.push(mod)
    console.error('[fail] ' + mod + ': ' + (error?.message ?? String(error)))
  }
}

if (failed.length) {
  console.error('\npreflight FAILED for: ' + failed.join(', '))
  console.error('检查宿主 peerDependencies 是否已在 profile node_modules 出现；bundle 安装必须用 file: 绝对路径。')
  process.exitCode = 1
} else {
  console.log('\npreflight OK: 宿主导板包与自写源文件均可 import。')
}