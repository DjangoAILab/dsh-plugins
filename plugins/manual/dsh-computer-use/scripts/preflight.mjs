// dsh-computer-use scripts/preflight.mjs
// 冷启动 import 预检：逐个 import 插件宿主依赖与自身源文件，在 bundle 冷启动前揪出
// 缺包或语法错误都应在 DSH 冷启动前暴露。
//
// 用法：node scripts/preflight.mjs

const MODULES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '../src/config.mjs',
  '../src/doctor.mjs',
  '../src/session.mjs',
  '../src/snapshot.mjs',
  '../src/approve.mjs',
  '../src/screenshot.mjs',
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
