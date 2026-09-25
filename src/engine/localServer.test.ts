/**
 * A call from the published page to a server on the user's machine fails with the same "Failed to
 * fetch" whether the server is down, the browser is waiting for or refused the local-network
 * permission, or Safari blocks it outright. These tests pin the words the user gets instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLocalAware, isLoopbackUrl, localServerHint, loopbackPermission } from './localServer.ts'

const PAGE = 'https://iskandeur.github.io/swarm-studio/'
const LAYA = 'http://127.0.0.1:8000/v1/systemone'

describe('isLoopbackUrl', () => {
  it('knows the loopback forms', () => {
    for (const url of [LAYA, 'http://localhost:11434/v1', 'http://app.localhost/x', 'http://[::1]:8000/', 'http://127.1.2.3/']) {
      expect(isLoopbackUrl(url), url).toBe(true)
    }
  })
  it('leaves the rest alone, a private LAN address included', () => {
    for (const url of ['https://openrouter.ai/api/alpha/decisions', 'http://192.168.1.10:8000/', 'http://127.example.com/', 'not a url', '']) {
      expect(isLoopbackUrl(url), url).toBe(false)
    }
  })
})

describe('localServerHint', () => {
  const base = { endpoint: LAYA, pageUrl: PAGE, start: 'tools/laya-serve-cors.py' }

  it('says nothing for a remote endpoint, or when the page itself is local', () => {
    expect(localServerHint({ ...base, endpoint: 'https://openrouter.ai/api/alpha/decisions', permission: 'prompt' })).toBeUndefined()
    expect(localServerHint({ ...base, pageUrl: 'http://localhost:5173/', permission: 'prompt' })).toBeUndefined()
  })

  it('a refused permission points to the site settings, not to the server', () => {
    const hint = localServerHint({ ...base, permission: 'denied' })!
    expect(hint).toMatch(/blocks this page from reaching http:\/\/127\.0\.0\.1:8000/)
    expect(hint).toMatch(/Apps on device/)
    expect(hint).not.toMatch(/laya-serve-cors/)
  })

  it('an unanswered or fresh permission: is the server up, and answer Allow', () => {
    const hint = localServerHint({ ...base, permission: 'prompt' })!
    expect(hint).toMatch(/Is tools\/laya-serve-cors\.py running\?/)
    expect(hint).toMatch(/answer Allow/)
  })

  it('a granted permission leaves only the server to blame', () => {
    const hint = localServerHint({ ...base, permission: 'granted' })!
    expect(hint).toMatch(/Is tools\/laya-serve-cors\.py running\?/)
    expect(hint).not.toMatch(/Allow/)
  })

  it('no permission to ask about, https page, http server: names the Safari dead end', () => {
    const hint = localServerHint({ ...base, permission: 'unsupported' })!
    expect(hint).toMatch(/Safari/)
    expect(hint).toMatch(/npm run dev/)
  })

  it('without a start command, asks about the server and its CORS origins', () => {
    expect(localServerHint({ endpoint: 'http://localhost:11434/v1/chat/completions', pageUrl: PAGE, permission: 'granted' })).toMatch(/allow this origin \(CORS\)/)
  })
})

describe('loopbackPermission', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads loopback-network first', async () => {
    const query = vi.fn(async ({ name }: { name: string }) => ({ state: name === 'loopback-network' ? 'denied' : 'granted' }))
    vi.stubGlobal('navigator', { permissions: { query } })
    expect(await loopbackPermission()).toBe('denied')
  })

  it('falls back to the pre-145 Chrome name', async () => {
    const query = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'loopback-network') throw new TypeError('not a valid enum value')
      return { state: 'prompt' }
    })
    vi.stubGlobal('navigator', { permissions: { query } })
    expect(await loopbackPermission()).toBe('prompt')
  })

  it('is unsupported when the browser knows neither name (WebKit)', async () => {
    vi.stubGlobal('navigator', { permissions: { query: vi.fn(async () => { throw new TypeError('bad name') }) } })
    expect(await loopbackPermission()).toBe('unsupported')
  })
})

describe('fetchLocalAware', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('explains a network failure towards a local server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    vi.stubGlobal('location', new URL(PAGE))
    vi.stubGlobal('navigator', { permissions: { query: vi.fn(async () => ({ state: 'denied' })) } })
    await expect(fetchLocalAware(LAYA, { method: 'POST' })).rejects.toThrow(/^Failed to fetch: your browser blocks this page/)
  })

  it('passes a remote failure and an abort through untouched', async () => {
    vi.stubGlobal('location', new URL(PAGE))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(fetchLocalAware('https://openrouter.ai/x', {})).rejects.toThrow(/^Failed to fetch$/)
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort }))
    await expect(fetchLocalAware(LAYA, {})).rejects.toBe(abort)
  })
})
