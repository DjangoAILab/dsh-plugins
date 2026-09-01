// parseKeyCombo（tools.mjs C5）单测：JS 侧严格解析 → 结构化 key plan。
// 键名表与 driver/axdriver.swift 的 KEY_CODES 镜像——两侧不同步会在这里先炸
// （F4：测试期直接解析 Swift 字典逐项比对，杜绝人工同步遗漏）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseKeyCombo, KEY_NAMES } from '../src/tools.mjs'

const CMD = 0x100000
const CTRL = 0x40000
const ALT = 0x80000
const SHIFT = 0x20000
const FN = 0x800000

test('parseKeyCombo: cmd+s / ctrl+a / cmd+shift+t → 正确 keycode+flags', () => {
  assert.deepEqual(parseKeyCombo('cmd+s'), { keyCode: 0x01, flags: CMD })
  assert.deepEqual(parseKeyCombo('ctrl+a'), { keyCode: 0x00, flags: CTRL })
  assert.deepEqual(parseKeyCombo('cmd+shift+t'), { keyCode: 0x11, flags: CMD | SHIFT })
  // 大小写不敏感 + command/control 全名别名
  assert.deepEqual(parseKeyCombo('Command+S'), { keyCode: 0x01, flags: CMD })
  assert.deepEqual(parseKeyCombo('control+a'), { keyCode: 0x00, flags: CTRL })
  assert.deepEqual(parseKeyCombo('option+left'), { keyCode: 123, flags: ALT })
})

test('parseKeyCombo: cmd+space / alt+left / fn+f1 可解析', () => {
  assert.deepEqual(parseKeyCombo('cmd+space'), { keyCode: 49, flags: CMD })
  assert.deepEqual(parseKeyCombo('alt+left'), { keyCode: 123, flags: ALT })
  assert.deepEqual(parseKeyCombo('fn+f1'), { keyCode: 122, flags: FN })
})

test('parseKeyCombo: cmd+retrun（拼写错）→ throw 且列出支持键名', () => {
  assert.throws(() => parseKeyCombo('cmd+retrun'), (err) => {
    const msg = String(err && err.message)
    return /未知按键名/.test(msg) && /retrun/.test(msg) && msg.includes('return')
  })
})

test('parseKeyCombo: cmd+plus → 0x18 + cmd|shift（物理 = 键）；minus 不加 shift', () => {
  assert.deepEqual(parseKeyCombo('cmd+plus'), { keyCode: 0x18, flags: CMD | SHIFT })
  assert.deepEqual(parseKeyCombo('cmd+minus'), { keyCode: 0x1B, flags: CMD })
})

test('parseKeyCombo: 空串 / 双主键 / 纯修饰键 → throw', () => {
  assert.throws(() => parseKeyCombo(''), /combo 不能为空/)
  assert.throws(() => parseKeyCombo('   '), /combo 不能为空/)
  assert.throws(() => parseKeyCombo('cmd+shift+a+b'), /主键必须恰好一个/)
  assert.throws(() => parseKeyCombo('cmd+shift'), /缺少主键/)
  assert.throws(() => parseKeyCombo('+++'), /缺少主键|无法解析/)
})

test('parseKeyCombo: 裸单字符 → unicode 路径（布局无关）；裸 return → keycode 无 flags', () => {
  assert.deepEqual(parseKeyCombo('a'), { unicode: 'a', flags: 0 })
  assert.deepEqual(parseKeyCombo('A'), { unicode: 'A', flags: 0 })
  // 非 ASCII 单字符（中文/全角标点）也走 unicode 注入
  assert.deepEqual(parseKeyCombo('中'), { unicode: '中', flags: 0 })
  assert.deepEqual(parseKeyCombo('return'), { keyCode: 36, flags: 0 })
  assert.deepEqual(parseKeyCombo('Escape'), { keyCode: 53, flags: 0 })
})

test('parseKeyCombo: 带修饰键的单字符若查表不中 → throw（绝不退化为文本注入）', () => {
  // 'é' 是单字符但带 cmd 修饰——unicode 注入无法携带修饰键，必须报错
  assert.throws(() => parseKeyCombo('cmd+é'), /未知按键名/)
})

test('parseKeyCombo: 多 code point 输入不是合法单字符主键', () => {
  assert.throws(() => parseKeyCombo('abc'), /未知按键名/)
})

// ---- F3：'+' 既是分隔符又是可键入字符 ----

test('parseKeyCombo: 裸 "+" → unicode 文本注入路径（F3 必须可用）', () => {
  assert.deepEqual(parseKeyCombo('+'), { unicode: '+', flags: 0 })
})

test('parseKeyCombo: "cmd++" → cmd 修饰 + plus 别名（0x18 + cmd|shift）', () => {
  assert.deepEqual(parseKeyCombo('cmd++'), { keyCode: 0x18, flags: CMD | SHIFT })
  // 'shift++' 物理上正好打出 "+" 字符
  assert.deepEqual(parseKeyCombo('shift++'), { keyCode: 0x18, flags: SHIFT })
})

test('parseKeyCombo: 结尾/内部多余的 "+" 报错且信息可自愈', () => {
  // 'a+' = 两个主键（'a' 与字面 '+'）
  assert.throws(() => parseKeyCombo('a+'), /主键必须恰好一个/)
  // 内部空段（'+a' / 'a++b' / '++' / '+++'）→ 无法解析，错误里提示裸 "+" 的正确传法
  for (const bad of ['+a', 'a++b', '++', '+++']) {
    assert.throws(() => parseKeyCombo(bad), (err) => {
      const msg = String(err && err.message)
      return /无法解析组合键/.test(msg) && msg.includes('直接传 "+"')
    }, 'combo=' + bad + ' 应报可读错误')
  }
})

// ---- F4：JS KEY_NAMES 与 Swift KEY_CODES 镜像一致性（防漂移）----

test('KEY_NAMES 与 driver/axdriver.swift 的 KEY_CODES 逐项一致（F4 防漂移）', () => {
  const swift = readFileSync(join(import.meta.dirname, '..', 'driver', 'axdriver.swift'), 'utf8')
  const dict = swift.match(/let KEY_CODES:\s*\[String:\s*UInt16\]\s*=\s*\[([\s\S]*?)\n\]/)
  assert.ok(dict, 'axdriver.swift 必须能解析出 KEY_CODES 字典（结构变了要同步本测试）')
  const swiftCodes = {}
  // Swift 字符串字面量：仅 "\\" 转义在本表出现；用 JSON.parse 还原键名。
  const entryRe = /"((?:[^"\\]|\\.)*)"\s*:\s*(0[xX][0-9A-Fa-f]+|\d+)/g
  for (const m of dict[1].matchAll(entryRe)) {
    const name = JSON.parse('"' + m[1] + '"')
    swiftCodes[name] = Number(m[2])
  }
  // QA 复审（2026-08-31）：>40 的弱断言防不住「两侧同时漏掉同一个键」——键集合的
  // deepEqual 保证两侧一致，这里把绝对数量钉到当前基线：任何人加/删键都必须显式
  // 更新这个数字（双侧同步改动会自然通过；单侧漏改会被 deepEqual 抓住）。
  const EXPECTED_KEY_COUNT = 78
  assert.equal(
    Object.keys(swiftCodes).length,
    EXPECTED_KEY_COUNT,
    '解析到的 Swift 键名数量偏离基线 ' + EXPECTED_KEY_COUNT + '（实际 ' +
      Object.keys(swiftCodes).length + '）——若有意增删键，请同步更新 EXPECTED_KEY_COUNT',
  )
  // 键集合一致（含 plus/minus 别名），键值逐项一致。
  assert.deepEqual(
    Object.keys(swiftCodes).sort(),
    Object.keys(KEY_NAMES).sort(),
    '两侧键名集合不一致——KEY_CODES 与 KEY_NAMES 必须同步改',
  )
  for (const [name, code] of Object.entries(swiftCodes)) {
    assert.equal(KEY_NAMES[name], code, '键 "' + name + '" 两侧 keycode 不一致')
  }
})
