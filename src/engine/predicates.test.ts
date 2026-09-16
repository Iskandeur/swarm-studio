/**
 * Conditions arrive inside pasted swarms, so most of these tests are about what goes WRONG: every
 * operator with a true and a false case, then the ways each can be malformed — which must answer
 * false with a readable sentence, never throw, and never freeze the tab.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Predicate } from '../types.ts'
import {
  describePredicate,
  evaluate,
  extractJson,
  hasNestedQuantifier,
  MAX_PATTERN_LENGTH,
  MAX_PREDICATE_DEPTH,
  MAX_SUBJECT_LENGTH,
  readPath,
  readPredicate,
  type PredicateContext,
} from './predicates.ts'

function ctx(text: string, extra: Partial<PredicateContext> = {}): PredicateContext {
  return { text, visits: 0, round: 1, readMemory: () => undefined, ...extra }
}

/** A malformed condition, cast past the type checker the way a paste gets past it. */
const raw = (value: unknown) => value as Predicate

/** A blackboard with two keys, matched by name the way the runner will: trimmed, case-insensitive. */
function board(entries: Record<string, string>): PredicateContext['readMemory'] {
  return (memory, key) => (memory.trim().toLowerCase() === 'evidence' ? entries[key] : undefined)
}

describe('an absent condition', () => {
  it('is always taken: an unguarded link carries every message', () => {
    expect(evaluate(undefined, ctx('anything'))).toEqual({ value: true })
  })

  it('treats null like absent, because that is how JSON spells nothing', () => {
    expect(evaluate(raw(null), ctx('anything'))).toEqual({ value: true })
  })
})

describe('always', () => {
  it('is true, with no problem', () => {
    expect(evaluate({ op: 'always' }, ctx(''))).toEqual({ value: true })
  })
})

describe('contains', () => {
  it('matches a substring without case by default', () => {
    expect(evaluate({ op: 'contains', value: 'guilty' }, ctx('The toaster is GUILTY.'))).toEqual({ value: true })
    expect(evaluate({ op: 'contains', value: 'guilty' }, ctx('The toaster is innocent.'))).toEqual({ value: false })
  })

  it('respects case when asked', () => {
    const predicate: Predicate = { op: 'contains', value: 'guilty', caseSensitive: true }
    expect(evaluate(predicate, ctx('GUILTY')).value).toBe(false)
    expect(evaluate(predicate, ctx('guilty as charged')).value).toBe(true)
  })

  it('is malformed without text to look for', () => {
    for (const bad of [{ op: 'contains' }, { op: 'contains', value: 7 }, { op: 'contains', value: 'x', caseSensitive: 'yes' }]) {
      const result = evaluate(raw(bad), ctx('x 7'))
      expect(result.value).toBe(false)
      expect(result.problem).toMatch(/contains/)
    }
  })
})

describe('matches', () => {
  it('tests a regular expression, with its flags', () => {
    expect(evaluate({ op: 'matches', pattern: '^yes', flags: 'i' }, ctx('Yes, obviously'))).toEqual({ value: true })
    expect(evaluate({ op: 'matches', pattern: '^yes' }, ctx('Yes, obviously'))).toEqual({ value: false })
    expect(evaluate({ op: 'matches', pattern: '^b', flags: 'm' }, ctx('a\nb')).value).toBe(true)
    expect(evaluate({ op: 'matches', pattern: 'a.b', flags: 's' }, ctx('a\nb')).value).toBe(true)
    expect(evaluate({ op: 'matches', pattern: 'a.b' }, ctx('a\nb')).value).toBe(false)
  })

  it('drops g and y, which would make the same guard answer differently twice in a row', () => {
    const predicate: Predicate = { op: 'matches', pattern: 'guilty', flags: 'gy' }
    const context = ctx('guilty guilty')
    expect(evaluate(predicate, context)).toEqual({ value: true })
    expect(evaluate(predicate, context)).toEqual({ value: true })
    expect(evaluate({ op: 'matches', pattern: 'guilty', flags: 'g' }, ctx('not guilty'))).toEqual({ value: true })
  })

  it('silently drops unknown and doubled flags instead of throwing', () => {
    expect(evaluate({ op: 'matches', pattern: 'YES', flags: 'xiiz!' }, ctx('yes'))).toEqual({ value: true })
  })

  it('refuses a pattern longer than the cap, and accepts one exactly at it', () => {
    const tooLong = evaluate({ op: 'matches', pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1) }, ctx('a'))
    expect(tooLong.value).toBe(false)
    expect(tooLong.problem).toMatch(/matches.*longer than 200/)
    const atCap = evaluate({ op: 'matches', pattern: 'a'.repeat(MAX_PATTERN_LENGTH) }, ctx('a'.repeat(MAX_PATTERN_LENGTH)))
    expect(atCap).toEqual({ value: true })
  })

  it('reports an invalid pattern instead of throwing', () => {
    for (const pattern of ['(', '[a-', '*', '(?<name>x)(?<name>y)']) {
      const result = evaluate({ op: 'matches', pattern }, ctx('anything'))
      expect(result.value).toBe(false)
      expect(result.problem).toMatch(/matches: .* is not a valid pattern/)
    }
  })

  it('reads only the first MAX_SUBJECT_LENGTH characters of the message', () => {
    const needle: Predicate = { op: 'matches', pattern: 'NEEDLE' }
    expect(evaluate(needle, ctx('a'.repeat(MAX_SUBJECT_LENGTH - 6) + 'NEEDLE')).value).toBe(true)
    expect(evaluate(needle, ctx('a'.repeat(MAX_SUBJECT_LENGTH) + 'NEEDLE')).value).toBe(false)
  })

  it('finishes on a backtracking-prone pattern over a huge message, because the subject is capped', () => {
    // Quadratic on its subject: over a million characters it would take minutes; capped, it returns.
    const started = Date.now()
    const result = evaluate({ op: 'matches', pattern: '[a-z]+@' }, ctx('a'.repeat(1_000_000)))
    expect(result).toEqual({ value: false })
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('is malformed without a pattern, or with flags that are not text', () => {
    for (const bad of [{ op: 'matches' }, { op: 'matches', pattern: 3 }, { op: 'matches', pattern: 'x', flags: 1 }]) {
      const result = evaluate(raw(bad), ctx('x'))
      expect(result.value).toBe(false)
      expect(result.problem).toMatch(/matches/)
    }
  })
})

describe('json', () => {
  const verdict = 'My verdict:\n```json\n{"verdict": {"score": 8, "guilty": "True"}, "tags": ["urgent", "legal"]}\n```'

  it('compares a value read along a dotted path', () => {
    expect(evaluate({ op: 'json', path: 'verdict.score', cmp: 'gte', value: 7 }, ctx(verdict))).toEqual({ value: true })
    expect(evaluate({ op: 'json', path: 'verdict.score', cmp: 'lt', value: 7 }, ctx(verdict))).toEqual({ value: false })
  })

  it('reads booleans the way the model meant them', () => {
    expect(evaluate({ op: 'json', path: 'verdict.guilty', cmp: 'eq', value: true }, ctx(verdict)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'verdict.guilty', cmp: 'neq', value: true }, ctx(verdict)).value).toBe(false)
  })

  it('finds a bare object in the middle of prose', () => {
    const text = 'I weighed it carefully. {"approved": false, "reason": "crumbs"} That is final.'
    expect(evaluate({ op: 'json', path: 'approved', cmp: 'eq', value: false }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'reason', cmp: 'contains', value: 'CRUMB' }, ctx(text)).value).toBe(true)
  })

  it('checks existence, where null does not count', () => {
    const text = '{"a": 0, "b": null}'
    expect(evaluate({ op: 'json', path: 'a', cmp: 'exists' }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'b', cmp: 'exists' }, ctx(text)).value).toBe(false)
    expect(evaluate({ op: 'json', path: 'c', cmp: 'exists' }, ctx(text)).value).toBe(false)
    expect(evaluate({ op: 'json', path: '', cmp: 'exists' }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: '', cmp: 'exists' }, ctx('no data here')).value).toBe(false)
  })

  it('looks for an element in an array with contains', () => {
    expect(evaluate({ op: 'json', path: 'tags', cmp: 'contains', value: 'LEGAL' }, ctx(verdict)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'tags', cmp: 'contains', value: 'leg' }, ctx(verdict)).value).toBe(false)
  })

  it('indexes arrays with numeric segments', () => {
    const text = '{"suspects": [{"name": "butler"}, {"name": "Toaster"}]}'
    expect(evaluate({ op: 'json', path: 'suspects.1.name', cmp: 'eq', value: 'toaster' }, ctx(text)).value).toBe(true)
  })

  it('is false, without a problem, when there is no JSON or no such path', () => {
    expect(evaluate({ op: 'json', path: 'score', cmp: 'gt', value: 1 }, ctx('I refuse to give a score.'))).toEqual({ value: false })
    expect(evaluate({ op: 'json', path: 'verdict.nope', cmp: 'eq', value: 1 }, ctx(verdict))).toEqual({ value: false })
    expect(evaluate({ op: 'json', path: 'verdict.score', cmp: 'neq', value: 1 }, ctx('no json'))).toEqual({ value: false })
  })

  it('is malformed with a bad path, a bad comparison or a missing value', () => {
    const cases: unknown[] = [
      { op: 'json', cmp: 'eq', value: 1 },
      { op: 'json', path: 'a..b', cmp: 'eq', value: 1 },
      { op: 'json', path: '.a', cmp: 'exists' },
      { op: 'json', path: 'a', cmp: 'like', value: 1 },
      { op: 'json', path: 'a', cmp: 'eq' },
      { op: 'json', path: 'a', cmp: 'eq', value: { nested: true } },
      { op: 'json', path: 'a', cmp: 'gt', value: Number.NaN },
    ]
    for (const bad of cases) {
      const result = evaluate(raw(bad), ctx('{"a": 1}'))
      expect(result.value, JSON.stringify(bad)).toBe(false)
      expect(result.problem, JSON.stringify(bad)).toMatch(/^json: /)
    }
  })
})

describe('memory', () => {
  const readMemory = board({ suspect: 'The Toaster', status: 'approved', count: '3' })

  it('compares a key of a memory node, by name', () => {
    const context = ctx('', { readMemory })
    expect(evaluate({ op: 'memory', memory: 'Evidence', key: 'suspect', cmp: 'eq', value: 'the toaster' }, context).value).toBe(true)
    expect(evaluate({ op: 'memory', memory: 'Evidence', key: 'suspect', cmp: 'eq', value: 'the butler' }, context).value).toBe(false)
    expect(evaluate({ op: 'memory', memory: 'Evidence', key: 'count', cmp: 'gte', value: 3 }, context).value).toBe(true)
    expect(evaluate({ op: 'memory', memory: 'Evidence', key: 'status', cmp: 'neq', value: 'approved' }, context).value).toBe(false)
  })

  it('passes the names through to the context untouched', () => {
    const calls: Array<[string, string]> = []
    const readMemory = (memory: string, key: string) => {
      calls.push([memory, key])
      return undefined
    }
    evaluate({ op: 'memory', memory: ' Evidence ', key: 'suspect', cmp: 'exists' }, ctx('', { readMemory }))
    expect(calls).toEqual([[' Evidence ', 'suspect']])
  })

  it('is false, without a problem, for a missing memory or key', () => {
    const context = ctx('', { readMemory })
    expect(evaluate({ op: 'memory', memory: 'Evidence', key: 'motive', cmp: 'exists' }, context)).toEqual({ value: false })
    expect(evaluate({ op: 'memory', memory: 'Gossip', key: 'suspect', cmp: 'neq', value: 'x' }, context)).toEqual({ value: false })
  })

  it('is malformed without a memory name or a key', () => {
    for (const bad of [
      { op: 'memory', key: 'k', cmp: 'exists' },
      { op: 'memory', memory: '  ', key: 'k', cmp: 'exists' },
      { op: 'memory', memory: 'Evidence', cmp: 'exists' },
      { op: 'memory', memory: 'Evidence', key: 'k', cmp: 'eq' },
    ]) {
      const result = evaluate(raw(bad), ctx('', { readMemory }))
      expect(result.value).toBe(false)
      expect(result.problem).toMatch(/^memory: /)
    }
  })

  it('survives a context that cannot read memory', () => {
    const predicate: Predicate = { op: 'memory', memory: 'Evidence', key: 'k', cmp: 'exists' }
    const missing = evaluate(predicate, { text: '', visits: 0, round: 1 } as unknown as PredicateContext)
    expect(missing.value).toBe(false)
    expect(missing.problem).toMatch(/memory/)
    const throwing = evaluate(predicate, ctx('', { readMemory: () => { throw new Error('store is gone') } }))
    expect(throwing.value).toBe(false)
    expect(throwing.problem).toMatch(/store is gone/)
  })
})

describe('comparisons', () => {
  // One table through `memory`, whose values are always text: that is where number-vs-string matters.
  const cases: Array<[string | undefined, string, string | number | boolean, boolean]> = [
    ['7', 'eq', 7, true],
    [' 7 ', 'eq', '7.0', true],
    ['7', 'eq', '07', true],
    ['10', 'gt', '9', true],
    ['10', 'gt', 9, true],
    ['9', 'gt', '10', false],
    ['5', 'lte', 5, true],
    ['5', 'lt', 5, false],
    ['5', 'gte', 5, true],
    ['-1.5', 'lt', 0, true],
    ['ten', 'gt', 9, false],
    ['0x10', 'eq', 16, false],
    ['', 'eq', 0, false],
    ['Toaster ', 'eq', 'toaster', true],
    ['toaster', 'neq', 'Toaster', false],
    ['true', 'eq', true, true],
    ['TRUE', 'eq', true, true],
    [' false ', 'eq', false, true],
    ['yes', 'eq', true, false],
    ['yes', 'neq', true, true],
    ['1', 'eq', true, false],
    ['The toaster did it', 'contains', 'TOASTER', true],
    ['The toaster did it', 'contains', 'butler', false],
    [undefined, 'eq', 'x', false],
    [undefined, 'neq', 'x', false],
    [undefined, 'contains', 'x', false],
  ]

  for (const [actual, cmp, value, expected] of cases) {
    it(`${JSON.stringify(actual)} ${cmp} ${JSON.stringify(value)} is ${expected}`, () => {
      const predicate = raw({ op: 'memory', memory: 'M', key: 'k', cmp, value })
      expect(evaluate(predicate, ctx('', { readMemory: () => actual }))).toEqual({ value: expected })
    })
  }

  it('compares JSON numbers and booleans with their text spellings', () => {
    const text = '{"n": 7, "b": true, "s": "7", "list": [1, "2", true]}'
    expect(evaluate({ op: 'json', path: 'n', cmp: 'eq', value: '7' }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 's', cmp: 'gt', value: 6 }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'b', cmp: 'eq', value: 'true' }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'list', cmp: 'contains', value: 2 }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'list', cmp: 'contains', value: true }, ctx(text)).value).toBe(true)
    expect(evaluate({ op: 'json', path: 'list', cmp: 'gt', value: 0 }, ctx(text)).value).toBe(false)
  })
})

describe('visits and round', () => {
  it('compares how many times this has fired', () => {
    const atMostThree: Predicate = { op: 'visits', cmp: 'lt', value: 3 }
    expect(evaluate(atMostThree, ctx('', { visits: 2 }))).toEqual({ value: true })
    expect(evaluate(atMostThree, ctx('', { visits: 3 }))).toEqual({ value: false })
  })

  it('supports every count comparison', () => {
    const at = (cmp: 'eq' | 'gt' | 'gte' | 'lt' | 'lte', visits: number) =>
      evaluate({ op: 'visits', cmp, value: 2 }, ctx('', { visits })).value
    expect([at('eq', 2), at('eq', 3)]).toEqual([true, false])
    expect([at('gt', 3), at('gt', 2)]).toEqual([true, false])
    expect([at('gte', 2), at('gte', 1)]).toEqual([true, false])
    expect([at('lte', 2), at('lte', 3)]).toEqual([true, false])
  })

  it('compares the round', () => {
    expect(evaluate({ op: 'round', cmp: 'gte', value: 4 }, ctx('', { round: 4 })).value).toBe(true)
    expect(evaluate({ op: 'round', cmp: 'gte', value: 4 }, ctx('', { round: 3 })).value).toBe(false)
  })

  it('is malformed with a comparison counts do not have, or a value that is not a number', () => {
    for (const bad of [
      { op: 'visits', cmp: 'neq', value: 1 },
      { op: 'visits', cmp: 'exists', value: 1 },
      { op: 'visits', cmp: 'lt', value: '3' },
      { op: 'round', cmp: 'lt' },
      { op: 'round', cmp: 'lt', value: Infinity },
    ]) {
      const result = evaluate(raw(bad), ctx('', { visits: 0, round: 1 }))
      expect(result.value).toBe(false)
      expect(result.problem).toMatch(new RegExp(`^${bad.op}: `))
    }
  })
})

describe('all, any, not', () => {
  const yes: Predicate = { op: 'always' }
  const no: Predicate = { op: 'contains', value: 'absent' }

  it('combines like logic', () => {
    expect(evaluate({ op: 'all', of: [yes, yes] }, ctx('')).value).toBe(true)
    expect(evaluate({ op: 'all', of: [yes, no] }, ctx('')).value).toBe(false)
    expect(evaluate({ op: 'any', of: [no, yes] }, ctx('')).value).toBe(true)
    expect(evaluate({ op: 'any', of: [no, no] }, ctx('')).value).toBe(false)
    expect(evaluate({ op: 'not', of: no }, ctx('')).value).toBe(true)
    expect(evaluate({ op: 'not', of: yes }, ctx('')).value).toBe(false)
  })

  it('gives an empty all true and an empty any false', () => {
    expect(evaluate({ op: 'all', of: [] }, ctx(''))).toEqual({ value: true })
    expect(evaluate({ op: 'any', of: [] }, ctx(''))).toEqual({ value: false })
  })

  it('nests: a critic loop that stops on a good score or after three drafts', () => {
    const stop: Predicate = {
      op: 'any',
      of: [
        { op: 'json', path: 'score', cmp: 'gte', value: 8 },
        { op: 'all', of: [{ op: 'visits', cmp: 'gte', value: 3 }, { op: 'not', of: { op: 'contains', value: 'abort' } }] },
      ],
    }
    expect(evaluate(stop, ctx('{"score": 9}', { visits: 0 })).value).toBe(true)
    expect(evaluate(stop, ctx('{"score": 5}', { visits: 1 })).value).toBe(false)
    expect(evaluate(stop, ctx('{"score": 5}', { visits: 3 })).value).toBe(true)
    expect(evaluate(stop, ctx('{"score": 5} abort', { visits: 3 })).value).toBe(false)
  })

  it('reports the FIRST problem met, in reading order', () => {
    const result = evaluate(
      raw({ op: 'all', of: [yes, { op: 'matches', pattern: '(' }, { op: 'teleport' }] }),
      ctx(''),
    )
    expect(result.value).toBe(false)
    expect(result.problem).toMatch(/matches/)
  })

  it('does not let a sibling or a negation rescue a broken condition', () => {
    // Otherwise `not` of a typo is "always", and a branch opens because of a missing quote.
    const broken = raw({ op: 'matches', pattern: '(' })
    for (const predicate of [
      raw({ op: 'not', of: broken }),
      raw({ op: 'any', of: [yes, broken] }),
      raw({ op: 'any', of: [broken, yes] }),
    ]) {
      const result = evaluate(predicate, ctx(''))
      expect(result.value).toBe(false)
      expect(result.problem).toMatch(/not a valid pattern/)
    }
  })

  it(`accepts ${MAX_PREDICATE_DEPTH} levels of nesting and refuses one more`, () => {
    let deepest: Predicate = { op: 'always' }
    for (let level = 1; level < MAX_PREDICATE_DEPTH; level++) deepest = { op: 'not', of: deepest }
    // 15 negations of always, 16 levels in all.
    expect(evaluate(deepest, ctx(''))).toEqual({ value: false })
    const tooDeep = evaluate({ op: 'not', of: deepest }, ctx(''))
    expect(tooDeep.value).toBe(false)
    expect(tooDeep.problem).toMatch(/deeper than 16/)
  })

  it('stops on a cyclic condition instead of overflowing the stack', () => {
    const loop: Record<string, unknown> = { op: 'all' }
    loop.of = [loop]
    const result = evaluate(raw(loop), ctx(''))
    expect(result.value).toBe(false)
    expect(result.problem).toMatch(/deeper than/)
  })

  it('is malformed without a list, or with something that is not a condition', () => {
    for (const bad of [{ op: 'all' }, { op: 'any', of: 'always' }, { op: 'not' }, { op: 'not', of: [yes] }, { op: 'all', of: [null] }]) {
      const result = evaluate(raw(bad), ctx(''))
      expect(result.value, JSON.stringify(bad)).toBe(false)
      expect(result.problem, JSON.stringify(bad)).toBeTruthy()
    }
  })
})

describe('malformed conditions', () => {
  it('never throw, evaluate to false, and say what is wrong', () => {
    const cases: Array<[unknown, RegExp]> = [
      [42, /object/],
      ['contains', /object/],
      [[], /object/],
      [{}, /needs an "op"/],
      [{ op: 5 }, /needs an "op"/],
      [{ op: 'teleport' }, /unknown condition "teleport"/],
      [{ op: 'CONTAINS', value: 'x' }, /unknown condition "CONTAINS"/],
      [{ op: 'x'.repeat(5000) }, /unknown condition "x+…"/],
    ]
    for (const [bad, problem] of cases) {
      // A throw would fail the test on its own; what is checked is the shape of the answer.
      const result = evaluate(raw(bad), ctx('x'))
      expect(result.value, JSON.stringify(bad).slice(0, 60)).toBe(false)
      expect(result.problem).toMatch(problem)
    }
  })

  it('survive a context whose text is not text', () => {
    const result = evaluate({ op: 'contains', value: 'x' }, { visits: 0, round: 1 } as unknown as PredicateContext)
    expect(result).toEqual({ value: false })
  })
})

describe('extractJson', () => {
  it('reads a ```json fenced block', () => {
    expect(extractJson('Verdict:\n```json\n{"score": 8}\n```\nThanks.')).toEqual({ score: 8 })
  })

  it('reads a bare ``` fenced block, and a longer fence', () => {
    expect(extractJson('```\n[1, 2]\n```')).toEqual([1, 2])
    expect(extractJson('````json\n{"a": "```"}\n````')).toEqual({ a: '```' })
  })

  it('prefers a fenced block over a bare object written earlier', () => {
    expect(extractJson('Draft was {"score": 3}, final:\n```json\n{"score": 9}\n```')).toEqual({ score: 9 })
  })

  it('does not prefer a fence in another language, but still finds the object by scanning', () => {
    const text = '```python\n{"lang": "python"}\n```\n```json\n{"lang": "json"}\n```'
    expect(extractJson(text)).toEqual({ lang: 'json' })
    expect(extractJson('```js\n{"only": "js"}\n```')).toEqual({ only: 'js' })
  })

  it('falls back to scanning when the fenced block does not parse', () => {
    expect(extractJson('```json\n{score: 8,}\n```\nCorrected: {"score": 8}')).toEqual({ score: 8 })
  })

  it('finds a bare object embedded in prose', () => {
    expect(extractJson('I would say {"guilty": true, "score": 9}. Case closed.')).toEqual({ guilty: true, score: 9 })
  })

  it('balances braces while ignoring the ones inside strings, including escaped quotes', () => {
    expect(extractJson('Note: {"hint": "use } and { freely", "n": 1} end')).toEqual({ hint: 'use } and { freely', n: 1 })
    expect(extractJson('{"quote": "he said \\"}\\" loudly", "n": 2}')).toEqual({ quote: 'he said "}" loudly', n: 2 })
  })

  it('skips prose brackets and links before the real value', () => {
    expect(extractJson('I {think} :-{ see [the docs](http://x) then {"a": {"b": [1, 2]}}')).toEqual({ a: { b: [1, 2] } })
  })

  it('returns the outermost value that starts first', () => {
    expect(extractJson('[{"a": 1}, {"a": 2}]')).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('returns undefined when there is nothing parseable', () => {
    for (const text of ['', 'no json at all', '{"unfinished": 1', '42', '"just a string"', '{not: json}', '```json\n```']) {
      expect(extractJson(text), JSON.stringify(text)).toBeUndefined()
    }
    expect(extractJson(undefined as unknown as string)).toBeUndefined()
  })

  it('gives up quickly on a message made of unclosed brackets', () => {
    const started = Date.now()
    expect(extractJson('['.repeat(200_000))).toBeUndefined()
    expect(extractJson('{"a": '.repeat(50_000))).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(4000)
  })
})

describe('readPath', () => {
  const value = { verdict: { score: 8, notes: ['crumbs', { where: 'toaster' }] }, '0': 'zero' }

  it('walks dotted keys and numeric array indexes', () => {
    expect(readPath(value, 'verdict.score')).toBe(8)
    expect(readPath(value, 'verdict.notes.0')).toBe('crumbs')
    expect(readPath(value, 'verdict.notes.1.where')).toBe('toaster')
    expect(readPath([[1, 2], [3, 4]], '1.0')).toBe(3)
    expect(readPath(value, '0')).toBe('zero')
    expect(readPath(value, ' verdict . score ')).toBe(8)
  })

  it('returns the value itself for an empty path', () => {
    expect(readPath(value, '')).toBe(value)
    expect(readPath(value, '   ')).toBe(value)
  })

  it('returns undefined for anything that is not there', () => {
    expect(readPath(value, 'verdict.missing')).toBeUndefined()
    expect(readPath(value, 'verdict.score.deeper')).toBeUndefined()
    expect(readPath(value, 'verdict.notes.7')).toBeUndefined()
    expect(readPath(value, 'verdict.notes.length')).toBeUndefined()
    expect(readPath(undefined, 'a')).toBeUndefined()
    expect(readPath(null, 'a')).toBeUndefined()
  })

  it('never reaches into the prototype chain', () => {
    for (const path of ['constructor', '__proto__', 'toString', 'verdict.hasOwnProperty']) {
      expect(readPath(value, path), path).toBeUndefined()
    }
    expect(readPath(JSON.parse('{"__proto__": {"x": 1}}'), '__proto__.x')).toBe(1)
  })
})

describe('describePredicate', () => {
  it('says each operator in words', () => {
    const cases: Array<[Predicate | undefined, string]> = [
      [undefined, 'always'],
      [{ op: 'always' }, 'always'],
      [{ op: 'contains', value: 'guilty' }, 'message contains "guilty"'],
      [{ op: 'contains', value: 'Guilty', caseSensitive: true }, 'message contains "Guilty" (case-sensitive)'],
      [{ op: 'matches', pattern: '^yes', flags: 'i' }, 'message matches /^yes/i'],
      [{ op: 'matches', pattern: '^yes', flags: 'gyi' }, 'message matches /^yes/i'],
      [{ op: 'json', path: 'verdict.score', cmp: 'gte', value: 7 }, 'JSON verdict.score ≥ 7'],
      [{ op: 'json', path: 'verdict', cmp: 'exists' }, 'JSON verdict exists'],
      [{ op: 'json', path: '', cmp: 'contains', value: 'x' }, 'JSON contains "x"'],
      [{ op: 'json', path: 'ok', cmp: 'neq', value: true }, 'JSON ok ≠ true'],
      [{ op: 'memory', memory: 'Evidence', key: 'suspect', cmp: 'eq', value: 'toaster' }, 'memory Evidence.suspect = "toaster"'],
      [{ op: 'visits', cmp: 'lt', value: 3 }, 'this has fired fewer than 3 times'],
      [{ op: 'visits', cmp: 'eq', value: 1 }, 'this has fired exactly 1 time'],
      [{ op: 'visits', cmp: 'gte', value: 2 }, 'this has fired at least 2 times'],
      [{ op: 'round', cmp: 'gte', value: 4 }, 'round ≥ 4'],
      [{ op: 'round', cmp: 'lt', value: 2 }, 'round < 2'],
      [
        { op: 'all', of: [{ op: 'contains', value: 'a' }, { op: 'round', cmp: 'lte', value: 2 }] },
        'all of (message contains "a" and round ≤ 2)',
      ],
      [
        { op: 'any', of: [{ op: 'contains', value: 'a' }, { op: 'contains', value: 'b' }] },
        'any of (message contains "a" or message contains "b")',
      ],
      [{ op: 'not', of: { op: 'contains', value: 'x' } }, 'not (message contains "x")'],
      [{ op: 'all', of: [] }, 'all of (nothing)'],
    ]
    for (const [predicate, words] of cases) expect(describePredicate(predicate)).toBe(words)
  })

  it('clips long values and escapes quotes', () => {
    expect(describePredicate({ op: 'contains', value: 'x'.repeat(500) })).toBe(`message contains "${'x'.repeat(80)}…"`)
    expect(describePredicate({ op: 'contains', value: 'say "hi"' })).toBe('message contains "say \\"hi\\""')
  })

  it('describes broken conditions as broken, without throwing', () => {
    expect(describePredicate(raw({ op: 'teleport' }))).toBe('unknown condition "teleport"')
    expect(describePredicate(raw(42))).toBe('invalid condition')
    expect(describePredicate(raw({ op: 'all', of: [42] }))).toBe('all of (invalid condition)')
    expect(describePredicate(raw({ op: 'json', cmp: 'eq' }))).toBe('JSON ? = ?')
    const loop: Record<string, unknown> = { op: 'not' }
    loop.of = loop
    expect(() => describePredicate(raw(loop))).not.toThrow()
  })
})

describe('readPredicate', () => {
  it('returns a valid condition unchanged', () => {
    const predicates: Predicate[] = [
      { op: 'always' },
      { op: 'contains', value: 'guilty', caseSensitive: true },
      { op: 'matches', pattern: '^yes', flags: 'i' },
      { op: 'json', path: 'verdict.score', cmp: 'gte', value: 7 },
      { op: 'memory', memory: 'Evidence', key: 'suspect', cmp: 'eq', value: 'toaster' },
      { op: 'visits', cmp: 'lt', value: 3 },
      { op: 'round', cmp: 'eq', value: 1 },
      { op: 'all', of: [{ op: 'not', of: { op: 'always' } }, { op: 'any', of: [] }] },
    ]
    for (const predicate of predicates) expect(readPredicate(JSON.parse(JSON.stringify(predicate)))).toStrictEqual(predicate)
  })

  it('keeps only known fields, and coerces what was obviously meant', () => {
    expect(readPredicate({ op: ' Contains ', value: 'x', colour: 'red', caseSensitive: 'true' })).toStrictEqual({
      op: 'contains',
      value: 'x',
      caseSensitive: true,
    })
    expect(readPredicate({ op: 'visits', cmp: 'LT', value: ' 3 ' })).toStrictEqual({ op: 'visits', cmp: 'lt', value: 3 })
    expect(readPredicate({ op: 'json', cmp: 'exists', value: 'ignored' })).toStrictEqual({ op: 'json', path: '', cmp: 'exists' })
    expect(readPredicate({ op: 'matches', pattern: 'x', flags: 'gimx' })).toStrictEqual({ op: 'matches', pattern: 'x', flags: 'im' })
    expect(readPredicate({ op: 'matches', pattern: 'x', flags: 'g' })).toStrictEqual({ op: 'matches', pattern: 'x' })
    expect(readPredicate({ op: 'memory', memory: ' Evidence ', key: 'k', cmp: 'eq', value: '007' })).toStrictEqual({
      op: 'memory',
      memory: 'Evidence',
      key: 'k',
      cmp: 'eq',
      value: '007',
    })
    expect(readPredicate({ op: 'not', of: [{ op: 'always' }] })).toStrictEqual({ op: 'not', of: { op: 'always' } })
  })

  it('keeps a pattern that evaluate will refuse, so the person sees what they pasted', () => {
    const pasted = readPredicate({ op: 'matches', pattern: '(' })
    expect(pasted).toStrictEqual({ op: 'matches', pattern: '(' })
    expect(evaluate(pasted, ctx('')).problem).toMatch(/not a valid pattern/)
  })

  it('drops the children it cannot read', () => {
    expect(readPredicate({ op: 'any', of: [{ op: 'always' }, { op: 'teleport' }, 42, null, { op: 'visits', cmp: 'lt' }] })).toStrictEqual({
      op: 'any',
      of: [{ op: 'always' }],
    })
  })

  it('applies the same depth limit, dropping what lies beyond it', () => {
    let deep: unknown = { op: 'always' }
    for (let level = 1; level < MAX_PREDICATE_DEPTH; level++) deep = { op: 'not', of: deep }
    expect(readPredicate(deep)).toBeDefined()
    expect(readPredicate({ op: 'not', of: deep })).toBeUndefined()
    expect(readPredicate({ op: 'all', of: [{ op: 'always' }, { op: 'not', of: deep }] })).toStrictEqual({
      op: 'all',
      of: [{ op: 'always' }],
    })
  })

  it('returns undefined for a root it cannot use', () => {
    for (const bad of [
      undefined,
      null,
      'always',
      [],
      {},
      { op: 'teleport' },
      { op: 'contains' },
      { op: 'matches', pattern: 5 },
      { op: 'json', path: 'a', cmp: 'eq' },
      { op: 'json', path: 'a', cmp: 'like', value: 1 },
      { op: 'json', path: {}, cmp: 'exists' },
      { op: 'memory', key: 'k', cmp: 'exists' },
      { op: 'memory', memory: 'M', cmp: 'exists' },
      { op: 'visits', cmp: 'lt', value: 'three' },
      { op: 'round', cmp: 'neq', value: 1 },
      { op: 'all', of: 'x' },
      { op: 'not', of: { op: 'teleport' } },
      { op: 'not', of: [{ op: 'always' }, { op: 'always' }] },
    ]) {
      expect(readPredicate(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('produces conditions that evaluate without a problem', () => {
    const read = readPredicate({ op: 'ALL', of: [{ op: 'json', path: 'score', cmp: 'gte', value: '7' }, { op: 'round', cmp: 'lte', value: '5' }] })
    expect(evaluate(read, ctx('{"score": 8}', { round: 2 }))).toEqual({ value: true })
  })
})

describe('the engine runs no code from data', () => {
  it('no engine source uses eval or the Function constructor', () => {
    // Through a variable on purpose: Vite rewrites the literal `new URL('.', import.meta.url)` into a
    // dev-server asset URL (http://localhost:3000/…), which the file system cannot read.
    const here = import.meta.url
    const dir = new URL('.', here)
    const sources = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    expect(sources).toContain('predicates.ts')
    for (const name of sources) {
      const source = readFileSync(new URL(name, dir), 'utf8')
      for (const forbidden of ['eval(', 'new Function', 'Function(']) {
        expect(source.includes(forbidden), `${name} contains ${forbidden}`).toBe(false)
      }
    }
  })
})

describe('patterns that would freeze the page', () => {
  it('refuses a repeated repetition before running it', () => {
    for (const pattern of ['(a+)+b', '(\\w*)*$', '(x|y+){2,}', '((ab)*c)+', '(?:a+)+']) {
      expect(hasNestedQuantifier(pattern), pattern).toBe(true)
      const started = Date.now()
      const result = evaluate({ op: 'matches', pattern }, ctx('a'.repeat(40) + '!'))
      expect(Date.now() - started).toBeLessThan(50)
      expect(result.value).toBe(false)
      expect(result.problem).toMatch(/freeze/)
    }
  })

  it('lets ordinary patterns through', () => {
    for (const pattern of ['^yes', '(guilty|innocent)', 'score: (\\d+)', '[a-z]+@[a-z]+', '(ab)+', '(a+)?b', '\\(a+\\)+', '[(a+)]+']) {
      expect(hasNestedQuantifier(pattern), pattern).toBe(false)
    }
  })
})
