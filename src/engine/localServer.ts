/**
 * Calling a server on your own machine (Laya, Ollama, LM Studio…) from the published page.
 *
 * The page lives on https://iskandeur.github.io, the server on http://127.0.0.1. Browsers treat that
 * as a public site reaching into your device, and a failed call only says "Failed to fetch", the
 * same words as a server that is not running. What each browser does, measured on 2026-09-25 with
 * Chrome 153, Firefox 155 and WebKit 26.6 against a stand-in server:
 *
 * - Chrome (142+), Edge, Brave: a prompt, "Access other apps and services on this device". The call
 *   waits while it is open, and goes through once allowed. After a Block, every call fails at once;
 *   it is undone in the site settings ("Apps on device"). The permission is `loopback-network`
 *   (`local-network-access` before Chrome 145, kept as an alias).
 * - Firefox (151+, rolled out progressively): the same kind of prompt, and the call waits for it.
 * - Safari: never. An https page may not call http://127.0.0.1 at all (mixed content, WebKit bug
 *   171934, open since 2017), and there is no prompt to answer.
 *
 * Opened from `npm run dev` (itself on localhost) none of this applies, in any browser.
 * CORS still applies everywhere: the server must allow the page's origin.
 */

export type LoopbackPermission = 'granted' | 'denied' | 'prompt' | 'unsupported'

/** 127.0.0.0/8, localhost (and *.localhost), ::1. */
export function isLoopbackUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/**
 * Why a call from `pageUrl` to a server on this machine failed before any answer, in words the user
 * can act on. `undefined` when the endpoint is not local, or the page is itself local.
 */
export function localServerHint(opts: {
  endpoint: string
  pageUrl: string
  permission: LoopbackPermission
  /** How to start the server, e.g. "tools/laya-serve-cors.py". */
  start?: string
}): string | undefined {
  if (!isLoopbackUrl(opts.endpoint) || isLoopbackUrl(opts.pageUrl)) return undefined
  let page: URL
  try {
    page = new URL(opts.pageUrl)
  } catch {
    return undefined
  }
  const target = new URL(opts.endpoint).origin
  const running = opts.start ? `Is ${opts.start} running?` : 'Is the server running, and does it allow this origin (CORS)?'
  if (opts.permission === 'denied') {
    return `your browser blocks this page from reaching ${target}. Allow it in the site settings (the icon left of the address; "Apps on device" in Chrome), then run again.`
  }
  if (opts.permission === 'unsupported' && page.protocol === 'https:' && new URL(opts.endpoint).protocol === 'http:') {
    return `the call to ${target} failed before any answer. ${running} If this is Safari: it never lets an https page call http://127.0.0.1, so use Chrome, Edge, Firefox or Brave, or run Swarm Studio locally (npm run dev).`
  }
  if (opts.permission === 'granted') return `the call to ${target} failed before any answer. ${running}`
  return `the call to ${target} failed before any answer. ${running} If your browser asks to let this page access other apps and services on this device, answer Allow.`
}

/** The page's permission to reach this machine, as far as the browser tells. */
export async function loopbackPermission(): Promise<LoopbackPermission> {
  const permissions = typeof navigator !== 'undefined' ? navigator.permissions : undefined
  if (!permissions?.query) return 'unsupported'
  // Chrome 145+ and Firefox answer `loopback-network`; Chrome 142-144 only knows the older name.
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      const { state } = await permissions.query({ name } as unknown as PermissionDescriptor)
      if (state === 'granted' || state === 'denied' || state === 'prompt') return state
    } catch {
      // unknown permission name in this browser: try the next one
    }
  }
  return 'unsupported'
}

/**
 * `fetch`, except that a network failure towards a local server says why. Other errors (an abort, an
 * HTTP error status) pass through untouched.
 */
export async function fetchLocalAware(url: string, init: RequestInit, start?: string): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if (!(err instanceof TypeError) || typeof location === 'undefined') throw err
    const hint = localServerHint({ endpoint: url, pageUrl: location.href, permission: await loopbackPermission(), start })
    if (!hint) throw err
    throw new Error(`${err.message.replace(/\.\s*$/, '')}: ${hint}`, { cause: err })
  }
}
