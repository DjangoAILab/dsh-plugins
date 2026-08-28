// dsh-browser-control scripts/preflight.mjs
// 冷启动 import 预检：逐个 import 插件宿主依赖与自身源文件，在 bundle 冷启动前揪出
// 缺包/语法错，而不是等 DSH 加载插件时才炸。与 dsh-external-agents 同约定。
//
// 用法（在已安装 bundle 的位置，或本仓库内带 ./node_modules 链接时）：
//   node scripts/preflight.mjs
// 返回 0 = 全部通过；非 0 = 第一个失败的模块名 + 错误。

const MODULES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '../src/config.mjs',
  '../src/snapshot.mjs',
  '../src/cdp.mjs',
  '../src/actions.mjs',
  '../src/session.mjs',
  '../src/launcher.mjs',
  '../src/approve.mjs',
  '../src/tools.mjs',
  '../src/index.mjs',
]

const failed = []
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
  console.log('\npreflight OK: 宿主依赖包与自写源文件均可 import。')
}