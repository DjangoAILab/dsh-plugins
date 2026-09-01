import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncateText } from '../src/truncate.mjs'

test('truncateText: short text passes through unchanged', () => {
  assert.equal(truncateText('hello', 10), 'hello')
  assert.equal(truncateText('', 10), '')
  assert.equal(truncateText('exactly10!', 10), 'exactly10!')
})

test('truncateText: long text is cut with omitted/total marker', () => {
  const out = truncateText('x'.repeat(25), 10)
  assert.ok(out.startsWith('x'.repeat(10)))
  assert.match(out, /\n…\[truncated 15 of 25 chars\]$/)
})

test('truncateText: invalid limit falls back to no truncation', () => {
  assert.equal(truncateText('hello', 0), 'hello')
  assert.equal(truncateText('hello', -3), 'hello')
  assert.equal(truncateText('hello', 'x'), 'hello')
})

test('truncateText: coerces non-string input', () => {
  assert.equal(truncateText(null, 10), 'null')
  assert.equal(truncateText(12345, 10), '12345')
})
