/**
 * Conditions on links and Condition nodes — as data, never as code.
 *
 * A pasted swarm comes from someone else. So nothing in a condition is ever turned into behaviour by
 * the JavaScript runtime: no eval, no Function constructor, no dynamic import. A condition is a small
 * tree of operators (`types.ts` → `Predicate`) and one pure function, `evaluate`, interprets it.
 *
 * Three promises, because a condition sits in the middle of a run that costs tokens:
 *  · it never throws — a typo in a guard must not kill a run; it evaluates to false with a problem
 *    a human can read, which the runner shows as a notice;
 *  · it cannot freeze the tab — patterns are length-capped, the regex subject is capped, the JSON
 *    scan has a work budget, and nesting is bounded (which also stops a cyclic object);
 *  · a malformed condition is false as a WHOLE — a broken child is not rescued by `not` or by a
 *    sibling in `any`, or a typo would silently open a branch.
 */
import type { Comparison, CountComparison, Predicate } from '../types.ts'

export const MAX_PATTERN_LENGTH = 200

/**
 * A group that contains a quantifier and is itself quantified: `(a+)+`, `(\w*)*`, `(x|y+){2,}`.
 *
 * That shape is what makes a backtracking engine go exponential, and a swarm pasted from someone
 * else can carry it — `(a+)+b` hangs the tab on thirty characters, and the subject cap does nothing
 * against it (found while writing this module). A browser offers no timeout on `RegExp.test` short
 * of a Worker, so the pattern is refused before it runs. It is a heuristic: it also refuses a few
 * harmless patterns, which costs a rewrite, where missing a bad one costs the page.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: boolean[] = []
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') {
      stack.push(false)
      continue
    }
    const quantifier = ch === '+' || ch === '*' || ch === '{' || (ch === '?' && pattern[i - 1] !== '(')
    if (ch === ')') {
      const innerQuantified = stack.pop() ?? false
      const next = pattern[i + 1]
      const outerQuantified = next === '+' || next === '*' || next === '{'
      if (innerQuantified && outerQuantified) return true
      // A quantified group makes its parent group quantified too.
      if (innerQuantified && stack.length > 0) stack[stack.length - 1] = true
      continue
    }
    if (quantifier && stack.length > 0) stack[stack.length - 1] = true
  }
  return false
}
export const MAX_SUBJECT_LENGTH = 20_000
/** Deeper than this is refused: no form builds it, and a cyclic object must not recurse for ever. */
export const MAX_PREDICATE_DEPTH = 16

const COMPARISONS: readonly string[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'] satisfies Comparison[]
const COUNT_COMPARISONS: readonly string[] = ['eq', 'gt', 'gte', 'lt', 'lte'] satisfies CountComparison[]
/**
 * `g` and `y` make `test()` stateful through `lastIndex`: the same guard would answer true then false
 * on the same message. Everything else JavaScript accepts (`d`, `v`) changes nothing a guard needs.
 */
const ALLOWED_FLAGS = 'imsu'
/**
 * Characters the bare-JSON scan may walk before giving up. A message made of ten thousand `[` would
 * otherwise cost a full scan per bracket; real answers find their object in a few hundred steps.
 */
const JSON_SCAN_BUDGET = 2_000_000
/** Anything quoted back to a human is clipped: a pasted 5 000-character value is not a label. */
const MAX_QUOTED_LENGTH = 80
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i

export interface PredicateContext {
  /** The message crossing the link or entering the node. */
  text: string
  /** How many times this link / node has fired in this run BEFORE this evaluation. */
  visits: number
  round: number
  /** Value of `key` in the memory node NAMED `memory` (match names case-insensitively, trimmed), or undefined. */
  readMemory: (memory: string, key: string) => string | undefined
  /**
   * Typed answers a Decision node attached to the message, by question name. Absent when no Decision
   * node is upstream: a `decision` condition is then false, with a problem that says why.
   */
  decision?: Record<string, unknown>
}

export interface Evaluation {
  value: boolean
  problem?: string
}

interface Scope {
  text: string
  ctx: PredicateContext
  /** The message's JSON, extracted at most once per evaluation however many `json` nodes ask. */
  json: () => unknown
}

/**
 * Evaluates a condition against a message. An absent condition is an unguarded link: always taken.
 * `null` counts as absent too, because that is how "nothing" is spelled in hand-edited JSON.
 */
export function evaluate(predicate: Predicate | undefined, ctx: PredicateContext): Evaluation {
  if (predicate === undefined || predicate === null) return { value: true }
  let extracted: { value: unknown } | undefined
  const text = typeof ctx?.text === 'string' ? ctx.text : ''
  const scope: Scope = {
    text,
    ctx,
    json: () => (extracted ??= { value: extractJson(text) }).value,
  }
  try {
    return run(predicate, scope, 1)
  } catch (error) {
    // Only a hostile context can get here (a readMemory that throws, a getter on the predicate).
    // The promise is the same: false, and a sentence.
    return fail(`the condition could not be evaluated (${error instanceof Error ? error.message : String(error)})`)
  }
}

function pass(value: boolean): Evaluation {
  return { value }
}

function fail(problem: string): Evaluation {
  return { value: false, problem }
}

function run(node: unknown, scope: Scope, depth: number): Evaluation {
  if (depth > MAX_PREDICATE_DEPTH) return fail(`conditions are nested deeper than ${MAX_PREDICATE_DEPTH} levels`)
  if (!isRecord(node)) return fail('a condition must be an object with an "op"')

  switch (node.op) {
    case 'always':
      return pass(true)

    case 'contains': {
      if (typeof node.value !== 'string') return fail('contains: "value" must be text')
      if (node.caseSensitive !== undefined && typeof node.caseSensitive !== 'boolean') {
        return fail('contains: "caseSensitive" must be true or false')
      }
      return pass(
        node.caseSensitive
          ? scope.text.includes(node.value)
          : scope.text.toLowerCase().includes(node.value.toLowerCase()),
      )
    }

    case 'matches': {
      if (typeof node.pattern !== 'string') return fail('matches: "pattern" must be text')
      if (node.flags !== undefined && typeof node.flags !== 'string') return fail('matches: "flags" must be text')
      if (node.pattern.length > MAX_PATTERN_LENGTH) {
        return fail(`matches: the pattern is longer than ${MAX_PATTERN_LENGTH} characters`)
      }
      if (hasNestedQuantifier(node.pattern)) {
        return fail(`matches: /${clip(node.pattern)}/ repeats a repetition, which can freeze the page — simplify it`)
      }
      let regex: RegExp
      try {
        regex = new RegExp(node.pattern, cleanFlags(node.flags))
      } catch (error) {
        return fail(`matches: /${clip(node.pattern)}/ is not a valid pattern (${error instanceof Error ? error.message : 'invalid'})`)
      }
      // The cap does not make a catastrophic pattern safe, but it keeps an ordinary one on a huge
      // message from costing seconds: a guard is read every time a message crosses the link.
      return pass(regex.test(scope.text.slice(0, MAX_SUBJECT_LENGTH)))
    }

    case 'json': {
      if (typeof node.path !== 'string') return fail('json: "path" must be text')
      if (node.path.trim() && node.path.split('.').some((segment) => !segment.trim())) {
        return fail(`json: the path "${clip(node.path)}" has an empty segment`)
      }
      const comparison = readComparison('json', node)
      if (typeof comparison === 'string') return fail(comparison)
      return pass(compare(readPath(scope.json(), node.path), comparison.cmp, comparison.value))
    }

    case 'decision': {
      if (typeof node.path !== 'string' || !node.path.trim()) return fail('decision: "path" must name an answer, like route.choice')
      if (node.path.split('.').some((segment) => !segment.trim())) {
        return fail(`decision: the path "${clip(node.path)}" has an empty segment`)
      }
      const comparison = readComparison('decision', node)
      if (typeof comparison === 'string') return fail(comparison)
      if (!isRecord(scope.ctx?.decision)) return fail('decision: no Decision node answered upstream of this message')
      return pass(compare(readPath(scope.ctx.decision, node.path), comparison.cmp, comparison.value))
    }

    case 'memory': {
      if (typeof node.memory !== 'string' || !node.memory.trim()) return fail('memory: "memory" must name a memory node')
      if (typeof node.key !== 'string') return fail('memory: "key" must be text')
      const comparison = readComparison('memory', node)
      if (typeof comparison === 'string') return fail(comparison)
      if (typeof scope.ctx?.readMemory !== 'function') return fail('memory: no memory can be read here')
      return pass(compare(scope.ctx.readMemory(node.memory, node.key), comparison.cmp, comparison.value))
    }

    case 'visits':
    case 'round': {
      const op = node.op
      if (typeof node.cmp !== 'string' || !COUNT_COMPARISONS.includes(node.cmp)) {
        return fail(`${op}: "cmp" must be one of ${COUNT_COMPARISONS.join(', ')}`)
      }
      if (typeof node.value !== 'number' || !Number.isFinite(node.value)) return fail(`${op}: "value" must be a number`)
      const actual = op === 'visits' ? scope.ctx?.visits : scope.ctx?.round
      return pass(typeof actual === 'number' && order(actual, node.cmp as CountComparison, node.value))
    }

    case 'all':
    case 'any': {
      const op = node.op
      if (!Array.isArray(node.of)) return fail(`${op}: "of" must be a list of conditions`)
      // Every child is evaluated, even once the answer is known: a broken child must be reported on
      // every message, not only on the messages that happen to reach it.
      let value = op === 'all'
      for (const child of node.of) {
        const result = run(child, scope, depth + 1)
        if (result.problem !== undefined) return fail(result.problem)
        value = op === 'all' ? value && result.value : value || result.value
      }
      return pass(value)
    }

    case 'not': {
      if (!isRecord(node.of)) return fail('not: "of" must be one condition')
      const result = run(node.of, scope, depth + 1)
      // Negating a broken condition would turn a typo into "always".
      return result.problem !== undefined ? fail(result.problem) : pass(!result.value)
    }

    default:
      return fail(typeof node.op === 'string' ? `unknown condition "${clip(node.op)}"` : 'a condition needs an "op"')
  }
}

function readComparison(op: string, node: Record<string, unknown>): { cmp: Comparison; value: unknown } | string {
  const cmp = node.cmp
  if (typeof cmp !== 'string' || !COMPARISONS.includes(cmp)) return `${op}: "cmp" must be one of ${COMPARISONS.join(', ')}`
  if (cmp === 'exists') return { cmp, value: undefined }
  if (node.value === undefined) return `${op}: "${cmp}" needs a "value"`
  if (!isScalar(node.value)) return `${op}: "value" must be text, a number, or true/false`
  return { cmp: cmp as Comparison, value: node.value }
}

/** The one comparison shared by `json` and `memory`, so the same verdict reads the same way from both. */
function compare(actual: unknown, cmp: Comparison, expected: unknown): boolean {
  if (cmp === 'exists') return actual !== undefined && actual !== null
  if (actual === undefined || actual === null) return false
  switch (cmp) {
    case 'eq':
      return equals(actual, expected)
    case 'neq':
      return !equals(actual, expected)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // "7" > "10" is true for strings. A verdict score is a number, whichever way the model wrote it.
      const a = asNumber(actual)
      const b = asNumber(expected)
      return a !== undefined && b !== undefined && order(a, cmp, b)
    }
    case 'contains':
      if (Array.isArray(actual)) {
        return actual.some((item) => item !== undefined && item !== null && equals(item, expected))
      }
      return asText(actual).toLowerCase().includes(asText(expected).toLowerCase())
  }
}

/**
 * Models write `"score": "7"` as often as `"score": 7`, and `"approved": "True"` as often as `true`.
 * Equality follows what was meant: numbers as numbers, booleans as booleans, text without case.
 */
function equals(a: unknown, b: unknown): boolean {
  const na = asNumber(a)
  const nb = asNumber(b)
  if (na !== undefined && nb !== undefined) return na === nb
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const ba = asBoolean(a)
    return ba !== undefined && ba === asBoolean(b)
  }
  return asText(a).trim().toLowerCase() === asText(b).trim().toLowerCase()
}

function order(a: number, cmp: CountComparison, b: number): boolean {
  switch (cmp) {
    case 'eq':
      return a === b
    case 'gt':
      return a > b
    case 'gte':
      return a >= b
    case 'lt':
      return a < b
    case 'lte':
      return a <= b
  }
}

/** A number, or a string that is a plain decimal number. `"0x10"` and `""` are not numbers here. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!DECIMAL.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const lowered = value.trim().toLowerCase()
  return lowered === 'true' ? true : lowered === 'false' ? false : undefined
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    // `String({})` is "[object Object]", which would equal the text "[object object]".
    try {
      return JSON.stringify(value) ?? ''
    } catch {
      return ''
    }
  }
  return String(value)
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanFlags(flags: unknown): string {
  if (typeof flags !== 'string') return ''
  let kept = ''
  // Deduplicated too: `new RegExp('x', 'ii')` throws, and a doubled flag is not worth a notice.
  for (const flag of flags) if (ALLOWED_FLAGS.includes(flag) && !kept.includes(flag)) kept += flag
  return kept
}

function clip(text: string, max = MAX_QUOTED_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/* ------------------------------------------------------------------------------------------------ */
/* JSON in a message                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The first JSON object or array in a model's answer. Models wrap it three ways: a ```json fence, a
 * bare ``` fence, or nothing at all in the middle of a sentence. A fence that parses wins, because it
 * is the one the model meant as data; otherwise the first bracket from which a balanced, parseable
 * value can be read. Nothing found is `undefined`, never a throw.
 */
export function extractJson(text: string): unknown | undefined {
  if (typeof text !== 'string' || !text) return undefined
  return fromFences(text) ?? fromBrackets(text)
}

function fromFences(text: string): unknown | undefined {
  let from = 0
  for (;;) {
    const open = text.indexOf('```', from)
    if (open < 0) return undefined
    let infoStart = open + 3
    while (text[infoStart] === '`') infoStart++
    const lineEnd = text.indexOf('\n', infoStart)
    if (lineEnd < 0) return undefined
    const sameLineClose = text.indexOf('```', infoStart)
    if (sameLineClose >= 0 && sameLineClose < lineEnd) {
      // ```{"a":1}``` on one line: not a block. The bracket scan will find what it holds.
      from = sameLineClose + 3
      continue
    }
    const close = text.indexOf('```', lineEnd + 1)
    if (close < 0) return undefined
    const language = text.slice(infoStart, lineEnd).trim().split(/\s+/)[0].toLowerCase()
    if (language === '' || language === 'json') {
      const parsed = parseContainer(text.slice(lineEnd + 1, close))
      if (parsed !== undefined) return parsed
    }
    from = close + 3
  }
}

function fromBrackets(text: string): unknown | undefined {
  const meter = { left: JSON_SCAN_BUDGET }
  for (let start = 0; start < text.length && meter.left > 0; start++) {
    const ch = text[start]
    if (ch !== '{' && ch !== '[') continue
    if (!canStartJson(text, start)) continue
    const end = balancedEnd(text, start, meter)
    if (end < 0) continue
    meter.left -= end - start
    const parsed = parseContainer(text.slice(start, end))
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/**
 * A cheap filter before the balanced scan: `{` must be followed by a key or `}`, `[` by a value or `]`.
 * Prose braces (`{curly}`, `:-{`) and markdown links (`[here]`) are skipped without being walked.
 */
function canStartJson(text: string, start: number): boolean {
  let i = start + 1
  while (i < text.length && /\s/.test(text[i])) i++
  const next = text[i]
  if (next === undefined) return false
  return text[start] === '{' ? next === '"' || next === '}' : /^["{[\]\-\dtfn]$/.test(next)
}

/** Index just past the bracket that closes the one at `start`, or -1. Strings and escapes are respected. */
function balancedEnd(text: string, start: number, meter: { left: number }): number {
  const expected: string[] = []
  let inString = false
  for (let i = start; i < text.length; i++) {
    if (--meter.left < 0) return -1
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') expected.push('}')
    else if (ch === '[') expected.push(']')
    else if (ch === '}' || ch === ']') {
      if (expected.pop() !== ch) return -1
      if (expected.length === 0) return i + 1
    }
  }
  return -1
}

function parseContainer(source: string): unknown | undefined {
  const trimmed = source.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads `a.b.0.c`. Numeric segments index arrays; an empty path is the value itself. Only OWN keys
 * are followed: `constructor` or `__proto__` must not reach into the prototype chain of a parsed
 * object and hand a function to a comparison.
 */
export function readPath(value: unknown, path: string): unknown {
  if (typeof path !== 'string') return undefined
  const trimmed = path.trim()
  if (!trimmed) return value
  let current = value
  for (const raw of trimmed.split('.')) {
    const segment = raw.trim()
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined
      current = current[Number(segment)]
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}

/* ------------------------------------------------------------------------------------------------ */
/* In words                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const SYMBOLS: Record<string, string> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }

/**
 * The condition as a short English phrase, for an edge tooltip and the editor's preview line. It
 * never throws either: a broken condition is described as broken, not as an empty string.
 */
export function describePredicate(predicate: Predicate | undefined): string {
  if (predicate === undefined || predicate === null) return 'always'
  try {
    return describe(predicate, 1)
  } catch {
    return 'invalid condition'
  }
}

function describe(node: unknown, depth: number): string {
  if (depth > MAX_PREDICATE_DEPTH) return '…'
  if (!isRecord(node)) return 'invalid condition'
  switch (node.op) {
    case 'always':
      return 'always'
    case 'contains':
      return `message contains ${quote(node.value)}${node.caseSensitive === true ? ' (case-sensitive)' : ''}`
    case 'matches':
      return `message matches /${typeof node.pattern === 'string' ? clip(node.pattern) : '?'}/${cleanFlags(node.flags)}`
    case 'json': {
      const path = typeof node.path === 'string' ? node.path.trim() : '?'
      return `JSON${path ? ` ${clip(path)}` : ''} ${describeComparison(node.cmp, node.value)}`
    }
    case 'decision': {
      const path = typeof node.path === 'string' ? clip(node.path.trim()) : '?'
      return `decision ${path || '?'} ${describeComparison(node.cmp, node.value)}`
    }
    case 'memory': {
      const memory = typeof node.memory === 'string' ? clip(node.memory.trim()) : '?'
      const key = typeof node.key === 'string' ? clip(node.key.trim()) : '?'
      return `memory ${key ? `${memory}.${key}` : memory} ${describeComparison(node.cmp, node.value)}`
    }
    case 'visits':
      return `this has fired ${describeCount(node.cmp, node.value)}`
    case 'round':
      return `round ${SYMBOLS[String(node.cmp)] ?? '?'} ${typeof node.value === 'number' ? node.value : '?'}`
    case 'all':
    case 'any': {
      if (!Array.isArray(node.of)) return `${node.op} of (?)`
      if (node.of.length === 0) return `${node.op} of (nothing)`
      const joiner = node.op === 'all' ? ' and ' : ' or '
      return `${node.op} of (${node.of.map((child) => describe(child, depth + 1)).join(joiner)})`
    }
    case 'not':
      return `not (${describe(node.of, depth + 1)})`
    default:
      return typeof node.op === 'string' ? `unknown condition "${clip(node.op)}"` : 'invalid condition'
  }
}

function describeComparison(cmp: unknown, value: unknown): string {
  if (cmp === 'exists') return 'exists'
  if (cmp === 'contains') return `contains ${quote(value)}`
  return `${SYMBOLS[String(cmp)] ?? '?'} ${quote(value)}`
}

function describeCount(cmp: unknown, value: unknown): string {
  const n = typeof value === 'number' ? value : NaN
  const count = Number.isFinite(n) ? `${n} ${n === 1 ? 'time' : 'times'}` : '? times'
  switch (cmp) {
    case 'lt':
      return `fewer than ${count}`
    case 'lte':
      return `at most ${count}`
    case 'gt':
      return `more than ${count}`
    case 'gte':
      return `at least ${count}`
    case 'eq':
      return `exactly ${count}`
    default:
      return `? ${count}`
  }
}

function quote(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(clip(value))
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return '?'
}

/* ------------------------------------------------------------------------------------------------ */
/* Reading pasted JSON                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/**
 * A lenient reader for a condition that came from outside (a paste, an older export, a hand edit):
 * keeps only the fields the operator knows, with the right types, and coerces what is obviously
 * meant (`"3"` where a count is expected, `"Contains"` as an op). Children of `all` / `any` that
 * cannot be read are dropped; a root that cannot be read is `undefined`.
 */
export function readPredicate(raw: unknown): Predicate | undefined {
  try {
    return read(raw, 1)
  } catch {
    return undefined
  }
}

function read(raw: unknown, depth: number): Predicate | undefined {
  if (depth > MAX_PREDICATE_DEPTH || !isRecord(raw)) return undefined
  const op = typeof raw.op === 'string' ? raw.op.trim().toLowerCase() : ''
  switch (op) {
    case 'always':
      return { op: 'always' }

    case 'contains': {
      const value = typeof raw.value === 'string' ? raw.value : isScalar(raw.value) ? String(raw.value) : undefined
      if (value === undefined) return undefined
      const caseSensitive = asBoolean(raw.caseSensitive)
      return caseSensitive === undefined ? { op: 'contains', value } : { op: 'contains', value, caseSensitive }
    }

    case 'matches': {
      if (typeof raw.pattern !== 'string') return undefined
      // A pattern that is too long or invalid is KEPT: `evaluate` reports it, and the editor can show
      // the person what they pasted instead of silently losing it.
      const flags = cleanFlags(raw.flags)
      return flags ? { op: 'matches', pattern: raw.pattern, flags } : { op: 'matches', pattern: raw.pattern }
    }

    case 'json': {
      const path = raw.path === undefined ? '' : typeof raw.path === 'string' ? raw.path.trim() : undefined
      const comparison = readLooseComparison(raw)
      if (path === undefined || !comparison) return undefined
      return { op: 'json', path, ...comparison }
    }

    case 'decision': {
      const path = typeof raw.path === 'string' ? raw.path.trim() : ''
      const comparison = readLooseComparison(raw)
      if (!path || !comparison) return undefined
      return { op: 'decision', path, ...comparison }
    }

    case 'memory': {
      const memory = typeof raw.memory === 'string' ? raw.memory.trim() : ''
      const comparison = readLooseComparison(raw)
      if (!memory || typeof raw.key !== 'string' || !comparison) return undefined
      return { op: 'memory', memory, key: raw.key.trim(), ...comparison }
    }

    case 'visits':
    case 'round': {
      const cmp = typeof raw.cmp === 'string' ? raw.cmp.trim().toLowerCase() : ''
      const value = asNumber(raw.value)
      if (!COUNT_COMPARISONS.includes(cmp) || value === undefined) return undefined
      return { op, cmp: cmp as CountComparison, value }
    }

    case 'all':
    case 'any': {
      if (!Array.isArray(raw.of)) return undefined
      const of: Predicate[] = []
      for (const child of raw.of) {
        const clean = read(child, depth + 1)
        if (clean) of.push(clean)
      }
      return { op, of }
    }

    case 'not': {
      // `of: [p]` is accepted: a form that stores every group as a list writes `not` that way.
      const inner = Array.isArray(raw.of) && raw.of.length === 1 ? raw.of[0] : raw.of
      const of = read(inner, depth + 1)
      return of ? { op: 'not', of } : undefined
    }

    default:
      return undefined
  }
}

function readLooseComparison(
  raw: Record<string, unknown>,
): { cmp: Comparison; value?: string | number | boolean } | undefined {
  const cmp = typeof raw.cmp === 'string' ? raw.cmp.trim().toLowerCase() : ''
  if (!COMPARISONS.includes(cmp)) return undefined
  if (cmp === 'exists') return { cmp: 'exists' }
  // Text stays text: `"007"` compares equal to 7 anyway, and a string compare must keep its zeros.
  if (!isScalar(raw.value)) return undefined
  return { cmp: cmp as Comparison, value: raw.value }
}
