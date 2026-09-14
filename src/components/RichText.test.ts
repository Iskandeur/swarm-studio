/**
 * The transcript renderer's parser. It runs on *half-written* text sixty times a second while a
 * message streams, so "tolerant" is a hard requirement, not politeness.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseBlocks, parseInline } from './RichText'

test('plain text is one paragraph', () => {
  assert.deepEqual(parseBlocks('hello there'), [
    { kind: 'paragraph', inlines: [{ kind: 'text', text: 'hello there' }] },
  ])
})

test('a blank line separates paragraphs, a single newline does not', () => {
  const twoLines = parseBlocks('one\ntwo')
  assert.equal(twoLines.length, 1)
  assert.deepEqual(twoLines[0], { kind: 'paragraph', inlines: [{ kind: 'text', text: 'one two' }] })
  assert.equal(parseBlocks('one\n\ntwo').length, 2)
})

test('bullets group into one list, and a different marker keeps grouping', () => {
  const blocks = parseBlocks('- first\n* second\n• third')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'list')
  if (blocks[0].kind !== 'list') throw new Error('expected a list')
  assert.equal(blocks[0].ordered, false)
  assert.equal(blocks[0].items.length, 3)
})

test('a numbered list is its own block, not a continuation of the bullets', () => {
  const blocks = parseBlocks('- a\n1. b')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].kind, 'list')
  if (blocks[1].kind !== 'list') throw new Error('expected a second list')
  assert.equal(blocks[1].ordered, true)
})

test('a fenced block keeps its lines verbatim, blank ones included', () => {
  const blocks = parseBlocks('before\n```ts\nconst a = 1\n\nconst b = 2\n```\nafter')
  assert.equal(blocks.length, 3)
  if (blocks[1].kind !== 'code') throw new Error('expected code')
  assert.equal(blocks[1].language, 'ts')
  assert.equal(blocks[1].text, 'const a = 1\n\nconst b = 2')
})

test('an UNCLOSED fence still renders as code — that is the normal streaming state', () => {
  const blocks = parseBlocks('```python\nprint("half')
  assert.equal(blocks.length, 1)
  if (blocks[0].kind !== 'code') throw new Error('expected code')
  assert.equal(blocks[0].text, 'print("half')
})

test('headings and quotes are recognised', () => {
  const blocks = parseBlocks('## Title\n> quoted line\nbody')
  assert.equal(blocks[0].kind, 'heading')
  if (blocks[0].kind !== 'heading') throw new Error('expected heading')
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[1].kind, 'quote')
  assert.equal(blocks[2].kind, 'paragraph')
})

test('inline emphasis splits into tokens', () => {
  assert.deepEqual(parseInline('a **b** c'), [
    { kind: 'text', text: 'a ' },
    { kind: 'bold', text: 'b' },
    { kind: 'text', text: ' c' },
  ])
  assert.deepEqual(parseInline('_soft_'), [{ kind: 'italic', text: 'soft' }])
})

test('a code span wins over emphasis inside it', () => {
  // Otherwise a pasted regex like `a**b` comes out mangled.
  assert.deepEqual(parseInline('use `a**b` here'), [
    { kind: 'text', text: 'use ' },
    { kind: 'code', text: 'a**b' },
    { kind: 'text', text: ' here' },
  ])
})

test('an unterminated marker stays literal instead of eating the rest', () => {
  assert.deepEqual(parseInline('half **open'), [{ kind: 'text', text: 'half **open' }])
  assert.deepEqual(parseInline('a `unclosed'), [{ kind: 'text', text: 'a `unclosed' }])
})

test('empty input yields no blocks, and never throws', () => {
  assert.deepEqual(parseBlocks(''), [])
  assert.deepEqual(parseBlocks('\n\n  \n'), [])
  assert.deepEqual(parseInline(''), [{ kind: 'text', text: '' }])
})

test('CRLF text parses like LF text', () => {
  assert.deepEqual(parseBlocks('a\r\n\r\nb'), parseBlocks('a\n\nb'))
})

test('a markdown table becomes a table, with its alignments', () => {
  const blocks = parseBlocks('| Model | idx | Notes |\n|---|--:|:-:|\n| gpt-5.2 | 30.4 | good |\n| oss | 12.3 | fast |')
  assert.equal(blocks.length, 1)
  if (blocks[0].kind !== 'table') throw new Error('expected a table')
  assert.deepEqual(blocks[0].head.map((cell) => cell.map((t) => t.text).join('')), ['Model', 'idx', 'Notes'])
  assert.deepEqual(blocks[0].align, ['left', 'right', 'center'])
  assert.equal(blocks[0].rows.length, 2)
  assert.deepEqual(blocks[0].rows[0].map((cell) => cell.map((t) => t.text).join('')), ['gpt-5.2', '30.4', 'good'])
})

test('a table without the leading and trailing pipes still parses', () => {
  const blocks = parseBlocks('a | b\n--- | ---\n1 | 2')
  assert.equal(blocks[0].kind, 'table')
  if (blocks[0].kind !== 'table') throw new Error('expected a table')
  assert.deepEqual(blocks[0].rows[0].map((cell) => cell.map((t) => t.text).join('')), ['1', '2'])
})

test('a ragged row is padded, not dropped', () => {
  // Normal while streaming: the row arrives before all its cells do.
  const blocks = parseBlocks('| a | b | c |\n|---|---|---|\n| 1 |')
  if (blocks[0].kind !== 'table') throw new Error('expected a table')
  assert.equal(blocks[0].rows[0].length, 3)
  assert.deepEqual(blocks[0].rows[0].map((cell) => cell.map((t) => t.text).join('')), ['1', '', ''])
})

test('a pipe in ordinary prose is NOT a table', () => {
  // This is the regression that matters: without the separator check, any sentence with a pipe in it
  // would be swallowed into a one-row table and stop reading like a sentence.
  const blocks = parseBlocks('use a | b for alternation')
  assert.equal(blocks[0].kind, 'paragraph')
  // …and a lone pipe row with nothing under it is prose too.
  assert.equal(parseBlocks('| not | a table |')[0].kind, 'paragraph')
})

test('inline formatting works inside table cells, and text after a table survives', () => {
  const blocks = parseBlocks('| a | b |\n|---|---|\n| `code` | **bold** |\n\nafter the table')
  if (blocks[0].kind !== 'table') throw new Error('expected a table')
  assert.deepEqual(blocks[0].rows[0][0], [{ kind: 'code', text: 'code' }])
  assert.deepEqual(blocks[0].rows[0][1], [{ kind: 'bold', text: 'bold' }])
  assert.equal(blocks[1].kind, 'paragraph')
  assert.deepEqual(blocks[1], { kind: 'paragraph', inlines: [{ kind: 'text', text: 'after the table' }] })
})

test('a table inside a code fence stays code', () => {
  const blocks = parseBlocks('```\n| a | b |\n|---|---|\n```')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'code')
})
