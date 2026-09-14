/**
 * jsdom has no layout engine, and React Flow measures the canvas on mount. These stubs let the
 * real components mount so a smoke test can catch an actual crash rather than a missing API.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1
  constructor(_transform?: string) {}
} as unknown as typeof DOMMatrixReadOnly

/**
 * A matchMedia that actually answers. jsdom ships none, and a stub hardwired to `matches: false`
 * would make every responsive branch untestable — the desktop layout would be the only one a test
 * could ever see, which is exactly the half that does not need checking on a phone.
 *
 * Supports `(max-width: Npx)`, `(min-width: Npx)` against `window.innerWidth`, and
 * `(pointer: coarse)` against `document.documentElement.dataset.pointer`.
 */
function evaluate(query: string): boolean {
  const max = /\(\s*max-width:\s*([\d.]+)px\s*\)/.exec(query)
  if (max) return window.innerWidth <= Number(max[1])
  const min = /\(\s*min-width:\s*([\d.]+)px\s*\)/.exec(query)
  if (min) return window.innerWidth >= Number(min[1])
  if (/pointer:\s*coarse/.test(query)) return document.documentElement.dataset.pointer === 'coarse'
  return false
}

window.matchMedia = ((query: string) => ({
  get matches() {
    return evaluate(query)
  },
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

/** Resizes the fake viewport so a test can pick a layout. */
export function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  window.dispatchEvent(new Event('resize'))
}

Element.prototype.scrollIntoView ??= () => {}

Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { get: () => 1200, configurable: true },
  offsetHeight: { get: () => 800, configurable: true },
})
