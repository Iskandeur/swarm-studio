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

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

Element.prototype.scrollIntoView ??= () => {}

Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { get: () => 1200, configurable: true },
  offsetHeight: { get: () => 800, configurable: true },
})
