import { test, beforeEach, afterEach } from 'vitest'
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react'
import App from './App'
import { useStore } from './store'
import { PRESETS } from './presets'
import { setViewport } from './test-setup'

beforeEach(() => {
  setViewport(1280)
  localStorage.clear()
  useStore.getState().loadPreset(PRESETS[0])
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

test('probe: cold open, press Backspace', async () => {
  const { container } = render(<App />)
  await waitFor(() => {
    if (!container.querySelector('.react-flow__node')) throw new Error('no nodes yet')
  }, { timeout: 4000 })

  const nodes = container.querySelectorAll('.react-flow__node')
  console.log('nodes:', [...nodes].map((n) => `${n.getAttribute('data-id')}:${n.className}`))
  console.log('before: selectedId=', useStore.getState().selectedId)

  fireEvent.keyDown(window, { key: 'Backspace' })
  await new Promise((r) => setTimeout(r, 300))
  const s = useStore.getState()
  console.log('after Backspace: agents=', s.spec.agents.map((a) => a.id),
    'links=', s.spec.links.map((l) => l.id), 'pastDepth=', s.past.length,
    'selectedId=', s.selectedId)
}, 20000)
