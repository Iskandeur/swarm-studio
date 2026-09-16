/**
 * The engine must be able to leave the browser.
 *
 * Running agents that execute code, keep going after the tab closes, or hold keys server-side all
 * need a backend one day. That move stays cheap only if `src/engine` knows nothing about the page:
 * no React, no MUI, no store, and no unguarded `window`/`document`. This test is the fence.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

// Not `import.meta.url`: under the jsdom environment it is not a file URL. Tests run from the root.
const dir = join(process.cwd(), 'src', 'engine')
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, code: readFileSync(`${dir}/${f}`, 'utf8') }))

test('there are engine sources to check', () => {
  assert.ok(sources.length >= 8, `found ${sources.length}`)
})

test('the engine imports nothing from the interface', () => {
  for (const { file, code } of sources) {
    const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const target of imports) {
      assert.ok(
        !/^(react|react-dom|@mui|@emotion|@xyflow|zustand)/.test(target) && !/store|components/.test(target),
        `${file} imports ${target}`,
      )
    }
  }
})

test('the engine touches no page global without checking it exists', () => {
  for (const { file, code } of sources) {
    const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(!/\b(window|document|localStorage)\./.test(withoutComments), `${file} reaches for a page global`)
  }
})
