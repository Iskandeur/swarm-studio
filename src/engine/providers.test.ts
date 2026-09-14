/**
 * Provider plumbing. These three functions decide *where* a call goes and *what models exist*,
 * so a mistake here sends an agent to the wrong host or hides every model behind a typo.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DEFAULT_ENDPOINTS, modelsUrlFrom, parseModelList, resolveEndpoint } from './providers.ts'

test('an empty override falls back to the official endpoint', () => {
  assert.equal(resolveEndpoint('openai'), DEFAULT_ENDPOINTS.openai)
  assert.equal(resolveEndpoint('openai', {}), DEFAULT_ENDPOINTS.openai)
  assert.equal(resolveEndpoint('openai', { openai: '   ' }), DEFAULT_ENDPOINTS.openai)
})

test('an override wins, and whitespace around a pasted URL is forgiven', () => {
  assert.equal(
    resolveEndpoint('openai', { openai: ' https://gateway.internal/v1/chat/completions \n' }),
    'https://gateway.internal/v1/chat/completions',
  )
})

test('the custom provider has no default: an empty URL stays empty', () => {
  assert.equal(resolveEndpoint('custom'), '')
  assert.equal(resolveEndpoint('custom', { custom: 'https://host/v1/chat/completions' }), 'https://host/v1/chat/completions')
})

test('the models URL is derived from the chat URL, whatever the dialect', () => {
  assert.equal(modelsUrlFrom('https://h/v1/chat/completions'), 'https://h/v1/models')
  assert.equal(modelsUrlFrom('https://h/api/v1/chat/completions/'), 'https://h/api/v1/models')
  assert.equal(modelsUrlFrom('https://h/v1/messages'), 'https://h/v1/models')
  // Unknown shape: append rather than guess wrong.
  assert.equal(modelsUrlFrom('https://h/openai/deployments'), 'https://h/openai/deployments/models')
})

test('model lists parse from all three gateway shapes', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b'])
  assert.deepEqual(parseModelList([{ id: 'solo' }]), ['solo'])
  // The "list of upstreams" shape: each entry carries its own models.
  assert.deepEqual(
    parseModelList([
      { host: 'one', models: [{ id: 'x' }] },
      { host: 'two', models: [{ id: 'y' }, { name: 'z' }] },
    ]),
    ['x', 'y', 'z'],
  )
})

test('a model list that is nothing like the expected shape yields nothing, not a crash', () => {
  assert.deepEqual(parseModelList(null), [])
  assert.deepEqual(parseModelList('nope'), [])
  assert.deepEqual(parseModelList({ error: 'unauthorized' }), [])
  // Duplicates across upstreams collapse.
  assert.deepEqual(parseModelList([{ models: [{ id: 'dup' }] }, { models: [{ id: 'dup' }] }]), ['dup'])
})
