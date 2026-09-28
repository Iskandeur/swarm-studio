/**
 * Retries — ADK 2.0's `RetryConfig`, adapted to a browser that pays with the user's own key.
 *
 * ADK retries every exception by default, five attempts. Here the default is narrower on purpose:
 * only failures that a second try can fix (rate limit, gateway hiccup, dropped connection). A wrong
 * key, a missing model, a context overflow fail the same way every time, and retrying them would only
 * spend the user's quota and hide the real cause behind a longer wait.
 *
 * Pure: no timers of its own. The sleep is injected, so tests run in zero time.
 */
import type { RetryPolicy } from '../types.ts'

export const DEFAULT_RETRY: Required<RetryPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
  jitter: 0.5,
  on: 'transient',
}

/** Caps a pasted spec cannot exceed: a swarm from someone else must not park the tab for an hour. */
const MAX_ATTEMPTS_CAP = 10
const MAX_DELAY_CAP = 120_000

/** The effective policy: the agent's over the swarm's over the default, each field clamped. */
export function resolveRetry(...layers: (RetryPolicy | undefined)[]): Required<RetryPolicy> {
  const merged = { ...DEFAULT_RETRY }
  for (const layer of layers) {
    if (!layer) continue
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value
    }
  }
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  return {
    maxAttempts: Math.min(MAX_ATTEMPTS_CAP, Math.max(1, Math.floor(num(merged.maxAttempts, DEFAULT_RETRY.maxAttempts)))),
    initialDelayMs: Math.min(MAX_DELAY_CAP, Math.max(0, num(merged.initialDelayMs, DEFAULT_RETRY.initialDelayMs))),
    maxDelayMs: Math.min(MAX_DELAY_CAP, Math.max(0, num(merged.maxDelayMs, DEFAULT_RETRY.maxDelayMs))),
    backoffFactor: Math.max(1, num(merged.backoffFactor, DEFAULT_RETRY.backoffFactor)),
    jitter: Math.min(1, Math.max(0, num(merged.jitter, DEFAULT_RETRY.jitter))),
    on: merged.on === 'all' ? 'all' : 'transient',
  }
}

/**
 * Can a second try succeed? Reads the error MESSAGE, because that is all a provider failure carries
 * here (`HTTP 429 — …`, or the browser's own network TypeError).
 */
export function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const status = /\bHTTP (\d{3})\b/.exec(message)
  if (status) {
    const code = Number(status[1])
    return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500
  }
  const lower = message.toLowerCase()
  return (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network error') ||
    lower.includes('load failed') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('rate limit') ||
    lower.includes('overloaded') ||
    lower.includes('timed out') ||
    lower.includes('timeout')
  )
}

/** Delay before retry number `retry` (1 = the first retry). `random` in [0, 1). */
export function retryDelay(retry: number, policy: Required<RetryPolicy>, random: number = Math.random()): number {
  const base = policy.initialDelayMs * policy.backoffFactor ** Math.max(0, retry - 1)
  const spread = base * policy.jitter * (random - 0.5)
  return Math.round(Math.min(policy.maxDelayMs, Math.max(0, base + spread)))
}

export interface RetryHooks {
  signal: AbortSignal
  /** Told before each wait: which retry is next, how long, and why. */
  onRetry?: (e: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Calls `fn` until it succeeds, the attempts run out, the error is not worth retrying, or the run
 * is stopped. The last error is rethrown untouched, so the transcript shows the provider's words.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: Required<RetryPolicy>, hooks: RetryHooks): Promise<T> {
  const sleep = hooks.sleep ?? abortableSleep
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (hooks.signal.aborted) throw err
      if (attempt >= policy.maxAttempts) throw err
      if (policy.on === 'transient' && !isTransient(err)) throw err
      const delayMs = retryDelay(attempt, policy, (hooks.random ?? Math.random)())
      hooks.onRetry?.({ attempt: attempt + 1, maxAttempts: policy.maxAttempts, delayMs, error: err })
      await sleep(delayMs, hooks.signal)
      if (hooks.signal.aborted) throw err
    }
  }
}
