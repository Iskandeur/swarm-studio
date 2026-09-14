import assert from 'node:assert/strict'
import { test } from 'vitest'
import { isTypingTarget, SHORTCUTS } from './useHotkeys'

test('a keystroke inside a field belongs to the field, not to the canvas', () => {
  // The bug this prevents: pressing Backspace while editing a prompt deletes the agent.
  for (const tag of ['input', 'textarea', 'select']) {
    assert.equal(isTypingTarget(document.createElement(tag)), true, tag)
  }
  const editable = document.createElement('div')
  editable.contentEditable = 'true'
  // jsdom does not implement isContentEditable from the attribute, so assert the property path.
  Object.defineProperty(editable, 'isContentEditable', { value: true })
  assert.equal(isTypingTarget(editable), true)
})

test('a keystroke on the page at large is ours', () => {
  assert.equal(isTypingTarget(document.createElement('div')), false)
  assert.equal(isTypingTarget(document.createElement('button')), false)
  assert.equal(isTypingTarget(null), false)
})

test('every advertised shortcut has a description', () => {
  assert.ok(SHORTCUTS.length >= 8)
  for (const shortcut of SHORTCUTS) {
    assert.ok(shortcut.keys.length > 0)
    assert.ok(shortcut.what.length > 0)
  }
})
