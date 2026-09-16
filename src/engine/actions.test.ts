/**
 * The action parser reads what models actually write: tags with sloppy quotes, tags split over lines,
 * tags quoted in code while explaining the syntax, tags never closed, and — while streaming — tags cut
 * in half. The one promise that covers all of it: it never throws, and it never invents an action.
 */
import { describe, expect, it } from 'vitest'
import { MAX_ACTIONS_PER_TURN, parseActions, stripActionTags } from './actions.ts'

describe('<route>', () => {
  it('reads every spelling the design allows', () => {
    const spellings: Array<[string, string[]]> = [
      ['<route to="guilty"/>', ['guilty']],
      ['<route to="a, b" />', ['a', 'b']],
      ['<route to=guilty>', ['guilty']],
      ['<route to=guilty/>', ['guilty']],
      ['<route>guilty</route>', ['guilty']],
      ["<route to='innocent'/>", ['innocent']],
      ['<ROUTE TO="Guilty"/>', ['Guilty']],
      ['<route\n  to = "guilty"\n/>', ['guilty']],
      ['< route to="guilty" / >', ['guilty']],
      ['<route>\n  guilty,\n  innocent\n</route>', ['guilty', 'innocent']],
    ]
    for (const [text, labels] of spellings) {
      const turn = parseActions(text)
      expect(turn.actions, text).toEqual([{ type: 'route', labels }])
      expect(turn.problems, text).toEqual([])
      expect(turn.prose, text).toBe('')
    }
  })

  it('trims labels, drops empty ones, and removes duplicates', () => {
    expect(parseActions('<route to=" a ,, b , a ,"/>').actions).toEqual([{ type: 'route', labels: ['a', 'b'] }])
  })

  it('unwraps a label the model quoted inside the body', () => {
    expect(parseActions('<route>"guilty", \'innocent\'</route>').actions).toEqual([
      { type: 'route', labels: ['guilty', 'innocent'] },
    ])
  })

  it('swallows an empty closing tag after the attribute form', () => {
    const turn = parseActions('Decided. <route to="guilty"></route> Next.')
    expect(turn.actions).toEqual([{ type: 'route', labels: ['guilty'] }])
    expect(turn.prose).toBe('Decided.  Next.')
  })

  it('keeps the attribute as the decision when a body is also given, and the body as prose', () => {
    const turn = parseActions('<route to="guilty">because of the crumbs</route>')
    expect(turn.actions).toEqual([{ type: 'route', labels: ['guilty'] }])
    expect(turn.prose).toBe('because of the crumbs')
  })

  it('reports a route that names nothing, and takes no action', () => {
    for (const text of ['<route/>', '<route to=""/>', '<route to=" , "/>', '<route>  </route>', '<route>']) {
      const turn = parseActions(`Hmm. ${text}`)
      expect(turn.actions, text).toEqual([])
      expect(turn.problems, text).toEqual([expect.stringMatching(/<route> names no branch/)])
      expect(turn.prose, text).toBe('Hmm.')
    }
  })

  it('ignores words that only start like the tag', () => {
    const text = 'See <routes> and <route-map> and <writer> and <spawned/>.'
    expect(parseActions(text)).toEqual({ prose: text, actions: [], problems: [] })
  })
})

describe('<write>', () => {
  it('reads a keyed write', () => {
    const turn = parseActions('<write memory="Evidence" key="suspect">The toaster</write>')
    expect(turn.actions).toEqual([{ type: 'write', memory: 'Evidence', key: 'suspect', value: 'The toaster' }])
    expect(turn.problems).toEqual([])
  })

  it('leaves the key out when there is none', () => {
    const [action] = parseActions('<write memory="Newsroom">Breaking: the toaster denies it</write>').actions
    expect(action).toStrictEqual({ type: 'write', memory: 'Newsroom', value: 'Breaking: the toaster denies it' })
    const [blankKey] = parseActions('<write memory="Newsroom" key="  ">x</write>').actions
    expect(blankKey).toStrictEqual({ type: 'write', memory: 'Newsroom', value: 'x' })
  })

  it('accepts single quotes, no quotes, and attributes spread over lines', () => {
    const texts = [
      "<write memory='Evidence' key='suspect'>The toaster</write>",
      '<write memory=Evidence key=suspect>The toaster</write>',
      '<WRITE\n  Memory="Evidence"\n  KEY="suspect"\n>The toaster</Write>',
    ]
    for (const text of texts) {
      expect(parseActions(text).actions, text).toEqual([
        { type: 'write', memory: 'Evidence', key: 'suspect', value: 'The toaster' },
      ])
    }
  })

  it('keeps a multi-line body, trimmed at both ends only', () => {
    const turn = parseActions('<write memory="Draft">\n\n# Apology\n\nDear office,\n  sorry.\n\n</write>')
    expect(turn.actions).toEqual([{ type: 'write', memory: 'Draft', value: '# Apology\n\nDear office,\n  sorry.' }])
  })

  it('accepts an empty body: clearing a key is a write too', () => {
    expect(parseActions('<write memory="Evidence" key="suspect"></write>').actions).toEqual([
      { type: 'write', memory: 'Evidence', key: 'suspect', value: '' },
    ])
  })

  it('reads a > inside a quoted attribute as part of the value', () => {
    expect(parseActions('<write memory="Before > After">x</write>').actions).toEqual([
      { type: 'write', memory: 'Before > After', value: 'x' },
    ])
  })

  it('takes tags inside the body as content, not as actions', () => {
    const turn = parseActions('<write memory="Manual">Choose with <route to="x"/> when done.</write>')
    expect(turn.actions).toEqual([{ type: 'write', memory: 'Manual', value: 'Choose with <route to="x"/> when done.' }])
  })

  it('does not end the body on a closing tag quoted in code', () => {
    const turn = parseActions('<write memory="Manual">Close it with `</write>`, like this.</write>')
    expect(turn.actions).toEqual([{ type: 'write', memory: 'Manual', value: 'Close it with `</write>`, like this.' }])
    expect(turn.prose).toBe('')
  })

  it('refuses a write without a memory, and removes the tag', () => {
    const turn = parseActions('Noted. <write key="suspect">The toaster</write>')
    expect(turn.actions).toEqual([])
    expect(turn.problems).toEqual([expect.stringMatching(/does not say which memory/)])
    expect(turn.prose).toBe('Noted.')
  })

  it('refuses a self-closing write: there is nothing to write', () => {
    const turn = parseActions('<write memory="Evidence" key="suspect"/>')
    expect(turn.actions).toEqual([])
    expect(turn.problems).toEqual([expect.stringMatching(/<write memory="Evidence"> has no body/)])
  })

  it('leaves an unclosed write in the prose, untouched, with a problem', () => {
    const text = 'Before.\n<write memory="Draft">half a thought that never ends'
    const turn = parseActions(text)
    expect(turn.actions).toEqual([])
    expect(turn.prose).toBe(text)
    expect(turn.problems).toEqual([expect.stringMatching(/<write memory="Draft"> is never closed with <\/write>/)])
  })

  it('does not let an unclosed write swallow the next one', () => {
    const turn = parseActions('<write memory="A">oops\n<write memory="B">fine</write>')
    expect(turn.actions).toEqual([{ type: 'write', memory: 'B', value: 'fine' }])
    expect(turn.prose).toBe('<write memory="A">oops')
    expect(turn.problems).toHaveLength(1)
  })
})

describe('<spawn>', () => {
  it('spawns a named agent with the body as its task', () => {
    const turn = parseActions('<spawn name="Forensic Accountant">Find the missing 12 €.</spawn>')
    expect(turn.actions).toStrictEqual([{ type: 'spawn', name: 'Forensic Accountant', task: 'Find the missing 12 €.' }])
    expect(turn.problems).toEqual([])
  })

  it('spawns a block', () => {
    const turn = parseActions("<spawn block='Critic loop'>\nWrite the apology note\nto the office.\n</spawn>")
    expect(turn.actions).toStrictEqual([{ type: 'spawn', block: 'Critic loop', task: 'Write the apology note\nto the office.' }])
  })

  it('needs a name or a block', () => {
    const turn = parseActions('<spawn>Do something.</spawn>')
    expect(turn.actions).toEqual([])
    expect(turn.problems).toEqual([expect.stringMatching(/needs a name or a block/)])
    expect(turn.prose).toBe('')
  })

  it('needs a task', () => {
    for (const text of ['<spawn name="Idle">   </spawn>', '<spawn name="Idle"/>']) {
      const turn = parseActions(text)
      expect(turn.actions, text).toEqual([])
      expect(turn.problems, text).toEqual([expect.stringMatching(/<spawn name="Idle"> has no (task|body)/)])
    }
  })

  it('leaves an unclosed spawn in the prose with a problem', () => {
    const text = '<spawn name="Ghost">haunt the kitchen'
    const turn = parseActions(text)
    expect(turn).toEqual({ prose: text, actions: [], problems: [expect.stringMatching(/never closed/)] })
  })
})

describe('code is an example, not an action', () => {
  it('ignores tags inside a fenced block and keeps them verbatim', () => {
    const text = 'To pick a branch, write:\n\n```\n<route to="guilty"/>\n```\n\nThat is all.'
    expect(parseActions(text)).toEqual({ prose: text, actions: [], problems: [] })
  })

  it('ignores tags inside a fence with a language, or a longer fence', () => {
    for (const text of [
      '```xml\n<write memory="Evidence">x</write>\n```',
      '````md\n```\n<spawn name="X">y</spawn>\n```\n````',
    ]) {
      expect(parseActions(text), text).toEqual({ prose: text, actions: [], problems: [] })
    }
  })

  it('ignores tags inside inline code, single or double backticks', () => {
    for (const text of [
      'Use `<route to="x"/>` to choose.',
      'Write ``<write memory="A">`x`</write>`` to save.',
    ]) {
      expect(parseActions(text), text).toEqual({ prose: text, actions: [], problems: [] })
    }
  })

  it('still reads the real tag written after the example', () => {
    const turn = parseActions('The syntax is `<route to="a"/>`. My choice: <route to="b"/>')
    expect(turn.actions).toEqual([{ type: 'route', labels: ['b'] }])
    expect(turn.prose).toBe('The syntax is `<route to="a"/>`. My choice:')
  })

  it('treats everything after an unclosed fence as code, as Markdown renders it', () => {
    const text = 'Example:\n```\n<route to="x"/>'
    expect(parseActions(text).actions).toEqual([])
  })

  it('does not let a stray backtick hide a tag in another paragraph', () => {
    const turn = parseActions("It's 5` o'clock.\n\n<route to=\"late\"/>\n\nSee you ` later.")
    expect(turn.actions).toEqual([{ type: 'route', labels: ['late'] }])
  })
})

describe('order and the cap', () => {
  it('returns actions in the order they were written', () => {
    const turn = parseActions(
      [
        '<spawn name="Scout">Look around.</spawn>',
        '<write memory="Log">started</write>',
        '<route to="next"/>',
        '<write memory="Log">done</write>',
      ].join('\n'),
    )
    expect(turn.actions.map((action) => action.type)).toEqual(['spawn', 'write', 'route', 'write'])
    expect(turn.actions[3]).toEqual({ type: 'write', memory: 'Log', value: 'done' })
  })

  it('keeps problems in text order too', () => {
    const turn = parseActions('<spawn>x</spawn> <route/> <write>y</write>')
    expect(turn.problems).toEqual([
      expect.stringMatching(/spawn/),
      expect.stringMatching(/route/),
      expect.stringMatching(/write/),
    ])
  })

  it(`keeps the first ${MAX_ACTIONS_PER_TURN} actions and says how many were dropped`, () => {
    const text = Array.from({ length: 25 }, (_, i) => `<route to="b${i}"/>`).join('\n')
    const turn = parseActions(text)
    expect(turn.actions).toHaveLength(MAX_ACTIONS_PER_TURN)
    expect(turn.actions[19]).toEqual({ type: 'route', labels: ['b19'] })
    expect(turn.problems).toEqual([expect.stringMatching(/^5 more actions were ignored/)])
    expect(turn.prose).toBe('')
  })

  it(`has nothing to say at exactly ${MAX_ACTIONS_PER_TURN}`, () => {
    const text = Array.from({ length: MAX_ACTIONS_PER_TURN }, (_, i) => `<route to="b${i}"/>`).join('')
    expect(parseActions(text).problems).toEqual([])
  })
})

describe('prose', () => {
  it('is the answer without its tags, with the blank lines they leave collapsed', () => {
    const text = [
      'Verdict below.   ',
      '',
      '<write memory="Evidence" key="suspect">The toaster</write>',
      '',
      '',
      '',
      'The butler is innocent.\t',
      '<route to="innocent"/>',
      '',
    ].join('\n')
    expect(parseActions(text).prose).toBe('Verdict below.\n\nThe butler is innocent.')
  })

  it('leaves an answer without tags as it was, apart from the edges', () => {
    const text = '  Plain answer.\n\nSecond paragraph with a < sign and 3 > 2.\n'
    expect(parseActions(text)).toEqual({
      prose: 'Plain answer.\n\nSecond paragraph with a < sign and 3 > 2.',
      actions: [],
      problems: [],
    })
  })

  it('leaves other markup alone', () => {
    const text = 'Some <b>bold</b> and <br/> and <div class="x">html</div>.'
    expect(parseActions(text).prose).toBe(text)
  })

  it('drops a closing tag that closes nothing', () => {
    expect(parseActions('Done.</route>').prose).toBe('Done.')
  })

  it('normalises Windows line endings', () => {
    expect(parseActions('a  \r\n\r\n\r\n\r\nb').prose).toBe('a\n\nb')
  })
})

describe('malformed tags', () => {
  it('leaves a tag it cannot read in the prose, with a problem', () => {
    const text = 'Going <route to=<b>somewhere</b>'
    const turn = parseActions(text)
    expect(turn.actions).toEqual([])
    expect(turn.prose).toBe(text)
    expect(turn.problems).toEqual([expect.stringMatching(/could not be read/)])
  })

  it('recovers the real tag written right after a broken one', () => {
    const turn = parseActions('<route to=<route to="x"/>')
    expect(turn.actions).toEqual([{ type: 'route', labels: ['x'] }])
  })

  it('reports an opening tag cut off at the end of a finished answer', () => {
    const turn = parseActions('Done. <route to="gu')
    expect(turn.actions).toEqual([])
    expect(turn.prose).toBe('Done. <route to="gu')
    expect(turn.problems).toEqual([expect.stringMatching(/unfinished <route>/)])
  })

  it('says nothing about a lone < or an unfinished word at the end', () => {
    expect(parseActions('x <')).toEqual({ prose: 'x <', actions: [], problems: [] })
    expect(parseActions('x <wri')).toEqual({ prose: 'x <wri', actions: [], problems: [] })
  })

  it('treats an unclosed quote that runs into another tag as broken', () => {
    const turn = parseActions('<write memory="A>oops</write> then <route to="b"/>')
    expect(turn.actions).toEqual([{ type: 'route', labels: ['b'] }])
    expect(turn.problems.length).toBeGreaterThan(0)
  })
})

describe('stripActionTags, while the answer streams', () => {
  it('removes complete tags like the final parse', () => {
    const text = 'Noted.\n<write memory="Evidence">The toaster</write>\nOff we go <route to="next"/>'
    expect(stripActionTags(text)).toBe(parseActions(text).prose)
  })

  it('hides a tag still being written at the end', () => {
    const cases: Array<[string, string]> = [
      ['Thinking <', 'Thinking'],
      ['Thinking <wri', 'Thinking'],
      ['Thinking < spa', 'Thinking'],
      ['Thinking <route to="gu', 'Thinking'],
      ['Thinking <route to="guilty"/', 'Thinking'],
      ['Thinking <write memory="Evidence" key=', 'Thinking'],
      ['Thinking <write memory="Evidence">The toa', 'Thinking'],
      ['Thinking <write memory="Evidence">The toaster</wri', 'Thinking'],
      ['Thinking <write memory="Evidence">The toaster</write', 'Thinking'],
      ['Thinking <write memory="Evidence">The toaster</ write ', 'Thinking'],
      ['Thinking <write memory="Evidence">The toaster</', 'Thinking'],
      ['Thinking <spawn name="Scout">Look', 'Thinking'],
      ['Thinking <route>gui', 'Thinking'],
    ]
    for (const [text, shown] of cases) expect(stripActionTags(text), text).toBe(shown)
  })

  it('shows what is not a tag in progress', () => {
    expect(stripActionTags('3 < 4 and <b>bold')).toBe('3 < 4 and <b>bold')
    expect(stripActionTags('Example:\n```\n<wri')).toBe('Example:\n```\n<wri')
  })

  it('shows an abandoned write once another one has started', () => {
    expect(stripActionTags('<write memory="A">oops\n<write memory="B">fine</write>')).toBe('<write memory="A">oops')
  })

  it('never shows a fragment of a tag at any point of a stream', () => {
    const full = [
      'Let me note it.',
      '<write memory="Evidence" key="suspect">The toaster</write>',
      'Now `inline` then I choose. <route to="guilty"/>',
      '<spawn name="Forensic Accountant">Find the missing 12 €.</spawn>',
      'Done.',
    ].join('\n')
    for (let length = 0; length <= full.length; length++) {
      const shown = stripActionTags(full.slice(0, length))
      expect(shown, `after ${length} characters`).not.toMatch(/<|The toaster|Find the missing/)
    }
    expect(stripActionTags(full)).toBe(parseActions(full).prose)
  })
})

describe('never throws', () => {
  it('accepts input that is not text', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(parseActions(value as unknown as string)).toEqual({ prose: '', actions: [], problems: [] })
      expect(stripActionTags(value as unknown as string)).toBe('')
    }
  })

  it('survives random tag soup', () => {
    // Seeded, so a failure is reproducible: mulberry32.
    let seed = 20260916
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pieces = [
      '<', '>', '/', '</', '/>', '"', "'", '=', ' ', '\n', '\n\n', '`', '```', '\\', ',',
      'route', 'write', 'spawn', 'ROUTE', 'to', 'memory', 'key', 'name', 'block',
      '<route', '<write', '<spawn', '</route>', '</write>', '</spawn>', '<route to="x"/>',
      'guilty', 'a', 'é', '€', ' ', '\ud83d', '\t',
    ]
    for (let run = 0; run < 3000; run++) {
      const length = Math.floor(random() * 40)
      let text = ''
      for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)]
      const turn = parseActions(text)
      expect(typeof turn.prose).toBe('string')
      expect(turn.actions.length).toBeLessThanOrEqual(MAX_ACTIONS_PER_TURN)
      expect(turn.problems.every((problem) => typeof problem === 'string')).toBe(true)
      for (const action of turn.actions) {
        if (action.type === 'route') expect(action.labels.length).toBeGreaterThan(0)
        if (action.type === 'write') expect(action.memory).not.toBe('')
        if (action.type === 'spawn') expect(action.task).not.toBe('')
      }
      expect(typeof stripActionTags(text)).toBe('string')
    }
  })

  it('stays fast on pathological input', () => {
    const started = Date.now()
    for (const text of [
      '<route to="'.repeat(20_000),
      '<write memory="a">'.repeat(10_000),
      '`'.repeat(100_000),
      '` '.repeat(50_000),
      '<'.repeat(100_000),
      ' '.repeat(100_000) + 'x',
      '<route '.repeat(20_000),
      `${'a'.repeat(100_000)}\n`.repeat(3),
    ]) {
      parseActions(text)
      stripActionTags(text)
    }
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
