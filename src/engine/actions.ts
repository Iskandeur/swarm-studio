/**
 * What an agent DOES, read out of what it wrote.
 *
 * Agents act with three tags in their answer — `<route>`, `<write>`, `<spawn>` — parsed once, at the
 * end of the turn (see docs/graph-engineering.md §3.7). Tags rather than native tool calls because
 * they behave the same on every provider, on the demo provider and on half-compatible gateways, and
 * because they stream: the viewer watches the decision being written.
 *
 * The price is that a model can malform a tag, so this parser is lenient where models are sloppy
 * (quotes, case, whitespace, newlines inside a tag) and strict where a guess would be dangerous:
 *  · a tag inside a code fence or inline code is an EXAMPLE, not an action — a model explaining the
 *    syntax to another agent must not trigger it;
 *  · a `<write>` or `<spawn>` whose end cannot be found is left in the prose untouched, because
 *    nobody knows where its body stops;
 *  · everything it could not read becomes a problem sentence, never a throw.
 *
 * The scan is linear in the length of the answer: tags are bounded, backtick runs are paired from
 * precomputed indexes, and no regular expression here can backtrack on a long input.
 */

export interface RouteAction {
  type: 'route'
  labels: string[]
}

export interface WriteAction {
  type: 'write'
  memory: string
  key?: string
  value: string
}

export interface SpawnAction {
  type: 'spawn'
  name?: string
  block?: string
  task: string
}

export type Action = RouteAction | WriteAction | SpawnAction

export interface ParsedTurn {
  /** The answer without its action tags: what the transcript shows and what links carry. */
  prose: string
  actions: Action[]
  problems: string[]
}

/** A turn that emits more than this is a model stuck in a loop, not a plan. */
export const MAX_ACTIONS_PER_TURN = 20

type TagName = 'route' | 'write' | 'spawn'
const TAG_NAMES: readonly TagName[] = ['route', 'write', 'spawn']
/** An opening tag longer than this is not a tag: attribute values are labels and names. */
const MAX_TAG_LENGTH = 500

type Token =
  | { kind: 'open'; name: TagName; attrs: Map<string, string>; selfClosing: boolean; start: number; end: number }
  | { kind: 'close'; name: TagName; start: number; end: number }
  /** Starts like one of our tags but cannot be read: a `<` inside it, or far too long. */
  | { kind: 'broken'; name: TagName; start: number }
  /** The text stops in the middle of what may still become a tag. Always the last token. */
  | { kind: 'partial'; name?: TagName; closing: boolean; start: number }

interface Scan {
  actions: Action[]
  problems: string[]
  /** Spans to cut out of the text, in order. */
  removals: Array<[number, number]>
}

/** Reads the actions of a finished turn, and the prose left once their tags are taken out. */
export function parseActions(text: string): ParsedTurn {
  const source = typeof text === 'string' ? text : ''
  try {
    const { actions, problems, removals } = scan(source, false)
    if (actions.length > MAX_ACTIONS_PER_TURN) {
      const dropped = actions.length - MAX_ACTIONS_PER_TURN
      problems.push(
        `${dropped} more ${dropped === 1 ? 'action was' : 'actions were'} ignored: at most ${MAX_ACTIONS_PER_TURN} per turn`,
      )
      actions.length = MAX_ACTIONS_PER_TURN
    }
    return { prose: tidy(cut(source, removals)), actions, problems }
  } catch {
    // Not expected to happen: the scanner has no throwing path. But a turn that fails to parse must
    // still be delivered, so the fallback is the raw answer with no actions.
    return { prose: tidy(source), actions: [], problems: ['the actions in this answer could not be read'] }
  }
}

/**
 * For a message STILL STREAMING: the text as it should be shown right now. Complete tags are removed
 * like in `parseActions`, and so is a tag still being written — a `<wri` at the very end, or a
 * `<write memory="X">` whose closing tag has not arrived yet — so the live view never flashes half a
 * tag, nor a memory write's body as if it were prose.
 */
export function stripActionTags(text: string): string {
  const source = typeof text === 'string' ? text : ''
  try {
    return tidy(cut(source, scan(source, true).removals))
  } catch {
    return tidy(source)
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Walking the tags                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

function scan(text: string, streaming: boolean): Scan {
  const tokens = tokenize(text)
  const actions: Action[] = []
  const problems: string[] = []
  const removals: Array<[number, number]> = []

  // For each token, the next token with the same tag name: that is where a body ends — or, when it is
  // another opening tag, the proof that this one was never closed.
  const nextSame = new Array<number>(tokens.length).fill(-1)
  const seen = new Map<TagName, number>()
  for (let k = tokens.length - 1; k >= 0; k--) {
    const token = tokens[k]
    if (token.kind === 'broken' || !token.name) continue
    nextSame[k] = seen.get(token.name) ?? -1
    seen.set(token.name, k)
  }

  const addRoute = (labels: string[]) => {
    if (labels.length === 0) problems.push('<route> names no branch, so it was ignored')
    else actions.push({ type: 'route', labels })
  }

  let k = 0
  while (k < tokens.length) {
    const token = tokens[k]

    if (token.kind === 'partial') {
      if (streaming) removals.push([token.start, text.length])
      else if (token.name) problems.push(`an unfinished <${token.name}> tag at the end was left as text`)
      k++
      continue
    }

    if (token.kind === 'broken') {
      problems.push(`a <${token.name}> tag could not be read and was left as text`)
      k++
      continue
    }

    if (token.kind === 'close') {
      // A closing tag with nothing to close carries nothing; forwarding it would only confuse the
      // next agent. Typically `<route to="x">guilty</route>`, where the attribute already said it all.
      removals.push([token.start, token.end])
      k++
      continue
    }

    const following = nextSame[k] >= 0 ? tokens[nextSame[k]] : undefined
    const closer = following?.kind === 'close' ? following : undefined
    // While streaming, a body with no closing tag YET is not a malformed tag: it is being written.
    // Followed by another opening tag, though, it was abandoned, and it shows like it will at the end.
    const stillArriving = streaming && (!following || (following.kind === 'partial' && following.closing))

    if (token.name === 'route') {
      const to = token.attrs.get('to')
      if (token.selfClosing || to !== undefined) {
        let end = token.end
        let next = k + 1
        const after = tokens[k + 1]
        if (
          !token.selfClosing &&
          after?.kind === 'close' &&
          after.name === 'route' &&
          !text.slice(token.end, after.start).trim()
        ) {
          // `<route to="x"></route>`: the empty closer belongs to it.
          end = after.end
          next = k + 2
        }
        removals.push([token.start, end])
        addRoute(splitLabels(to ?? ''))
        k = next
        continue
      }
      if (closer) {
        // `<route>guilty, innocent</route>`
        removals.push([token.start, closer.end])
        addRoute(splitLabels(text.slice(token.end, closer.start)))
        k = nextSame[k] + 1
        continue
      }
      if (stillArriving) {
        // `<route>gui…`: the label is still arriving.
        removals.push([token.start, text.length])
        break
      }
      removals.push([token.start, token.end])
      addRoute([])
      k++
      continue
    }

    // `<write>` and `<spawn>`: both need a body.
    if (token.selfClosing) {
      removals.push([token.start, token.end])
      problems.push(`${describeTag(token)} has no body, so it was ignored`)
      k++
      continue
    }
    if (!closer) {
      if (stillArriving) {
        // The body is still being written. Hiding it is the point: a memory write is not prose.
        removals.push([token.start, text.length])
        break
      }
      problems.push(`${describeTag(token)} is never closed with </${token.name}>, so it was left as text`)
      k++
      continue
    }

    // Whatever sits between the tags is the body, taken as is: tags inside it are its content.
    removals.push([token.start, closer.end])
    const body = text.slice(token.end, closer.start).trim()
    if (token.name === 'write') {
      const memory = token.attrs.get('memory')?.trim()
      const key = token.attrs.get('key')?.trim()
      if (!memory) problems.push(`${describeTag(token)} does not say which memory, so it was ignored`)
      else actions.push(key ? { type: 'write', memory, key, value: body } : { type: 'write', memory, value: body })
    } else {
      const name = token.attrs.get('name')?.trim() || undefined
      const block = token.attrs.get('block')?.trim() || undefined
      if (!name && !block) problems.push('<spawn> needs a name or a block, so it was ignored')
      else if (!body) problems.push(`${describeTag(token)} has no task, so it was ignored`)
      else actions.push({ type: 'spawn', ...(name ? { name } : {}), ...(block ? { block } : {}), task: body })
    }
    k = nextSame[k] + 1
  }

  return { actions, problems, removals }
}

/** `<write memory="Evidence">`, for a problem sentence: enough to find the tag in the answer. */
function describeTag(token: { name: TagName; attrs: Map<string, string> }): string {
  for (const attr of ['memory', 'name', 'block', 'to']) {
    const value = token.attrs.get(attr)?.trim()
    if (value) return `<${token.name} ${attr}="${value.length > 40 ? `${value.slice(0, 40)}…` : value}">`
  }
  return `<${token.name}>`
}

function splitLabels(raw: string): string[] {
  const labels: string[] = []
  for (const part of raw.split(',')) {
    let label = part.trim()
    // `<route>"guilty"</route>`: models quote what they were shown quoted.
    if (label.length >= 2 && (label[0] === '"' || label[0] === "'") && label.at(-1) === label[0]) {
      label = label.slice(1, -1).trim()
    }
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

function cut(text: string, removals: Array<[number, number]>): string {
  if (removals.length === 0) return text
  const sorted = [...removals].sort((a, b) => a[0] - b[0])
  let out = ''
  let from = 0
  for (const [start, end] of sorted) {
    if (start > from) out += text.slice(from, start)
    from = Math.max(from, end)
  }
  return out + text.slice(from)
}

/**
 * Removing a tag that sat on its own line leaves blank lines and trailing spaces behind. Written with
 * loops rather than `/[ \t]+$/gm`, which backtracks quadratically on a long run of spaces.
 */
function tidy(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let end = line.length
    while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
    if (end < line.length) lines[i] = line.slice(0, end)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/* ------------------------------------------------------------------------------------------------ */
/* Tokens                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

function tokenize(text: string): Token[] {
  const code = codeRanges(text)
  const tokens: Token[] = []
  let range = 0
  let i = text.indexOf('<')
  while (i >= 0) {
    while (range < code.length && code[range][1] <= i) range++
    if (range < code.length && code[range][0] <= i) {
      i = text.indexOf('<', code[range][1])
      continue
    }
    const token = readTag(text, i)
    if (!token) {
      i = text.indexOf('<', i + 1)
      continue
    }
    tokens.push(token)
    if (token.kind === 'partial') break
    // A broken tag may hide a real one after its `<`: `<route to=<route to="x"/>`.
    i = text.indexOf('<', token.kind === 'broken' ? i + 1 : token.end)
  }
  return tokens
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v'
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
}

function isAttributeChar(ch: string | undefined): boolean {
  return ch !== undefined && (isLetter(ch) || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-' || ch === ':')
}

/** Reads one tag starting at the `<` at `start`, or `undefined` when it is not one of ours. */
function readTag(text: string, start: number): Token | undefined {
  // Everything is read within `stop`. Reaching the end of the TEXT before it means the tag may still
  // be arriving (partial); reaching the bound before the end means it is not a tag we can read.
  const stop = Math.min(text.length, start + MAX_TAG_LENGTH)
  let i = start + 1
  while (i < stop && (text[i] === ' ' || text[i] === '\t')) i++
  const closing = text[i] === '/'
  if (closing) {
    i++
    while (i < stop && (text[i] === ' ' || text[i] === '\t')) i++
  }
  const nameStart = i
  while (i < stop && isLetter(text[i])) i++
  const word = text.slice(nameStart, i).toLowerCase()
  if (i >= text.length) {
    // `<`, `<wri`, `</spa` at the very end: it may become a tag with the next token.
    if (!TAG_NAMES.some((candidate) => candidate.startsWith(word))) return undefined
    return { kind: 'partial', name: TAG_NAMES.find((candidate) => candidate === word), closing, start }
  }
  const name = TAG_NAMES.find((candidate) => candidate === word)
  if (!name) return undefined
  // `<writer>`, `<spawned>` and `<route-map>` are other words.
  if (!isSpace(text[i]) && text[i] !== '/' && text[i] !== '>') return undefined

  const endOfInput = (): Token =>
    stop === text.length ? { kind: 'partial', name, closing, start } : { kind: 'broken', name, start }

  if (closing) {
    while (i < stop && isSpace(text[i])) i++
    if (i >= stop) return endOfInput()
    return text[i] === '>' ? { kind: 'close', name, start, end: i + 1 } : undefined
  }

  const attrs = new Map<string, string>()
  // The first spelling of an attribute wins, as in HTML.
  const set = (attr: string, value: string) => {
    if (!attrs.has(attr)) attrs.set(attr, value)
  }
  for (;;) {
    while (i < stop && isSpace(text[i])) i++
    if (i >= stop) return endOfInput()
    const ch = text[i]
    if (ch === '>') return { kind: 'open', name, attrs, selfClosing: false, start, end: i + 1 }
    if (ch === '<') return { kind: 'broken', name, start }
    if (ch === '/') {
      let j = i + 1
      while (j < stop && isSpace(text[j])) j++
      if (j >= stop) return endOfInput()
      if (text[j] === '>') return { kind: 'open', name, attrs, selfClosing: true, start, end: j + 1 }
      i++
      continue
    }
    if (!isAttributeChar(ch)) {
      // A stray quote or comma between attributes: skipped, like a browser would.
      i++
      continue
    }

    const attrStart = i
    while (i < stop && isAttributeChar(text[i])) i++
    const attr = text.slice(attrStart, i).toLowerCase()
    while (i < stop && isSpace(text[i])) i++
    if (i >= stop) return endOfInput()
    if (text[i] !== '=') {
      set(attr, '')
      continue
    }
    i++
    while (i < stop && isSpace(text[i])) i++
    if (i >= stop) return endOfInput()

    const quote = text[i]
    if (quote === '"' || quote === "'") {
      // Searched within the bound only: a thousand `<route to="` with no closing quote must not each
      // walk to the end of the answer.
      const offset = text.slice(i + 1, stop).indexOf(quote)
      if (offset < 0) return endOfInput()
      const close = i + 1 + offset
      const value = text.slice(i + 1, close)
      // A `<` inside a value means the quote was never closed and swallowed the next tag.
      if (value.includes('<')) return { kind: 'broken', name, start }
      set(attr, value)
      i = close + 1
      continue
    }

    const valueStart = i
    while (i < stop && !isSpace(text[i]) && text[i] !== '>' && text[i] !== '<') i++
    if (i >= stop) return endOfInput()
    const value = text.slice(valueStart, i)
    if (text[i] === '>' && value.endsWith('/')) {
      // `<route to=guilty/>`: the slash closes the tag, it is not part of the label.
      set(attr, value.slice(0, -1))
      return { kind: 'open', name, attrs, selfClosing: true, start, end: i + 1 }
    }
    set(attr, value)
  }
}

/**
 * Where the answer is code: fenced blocks and inline spans, as `[start, end)` pairs in order.
 *
 * Markdown's rules, simplified to what matters here: a run of three or more backticks opens a fence
 * that ends at a run at least as long — or at the end of the text, since an unclosed fence still
 * renders as code; a shorter run opens inline code that ends at a run of the SAME length, without
 * crossing a blank line, and is literal backticks otherwise.
 */
function codeRanges(text: string): Array<[number, number]> {
  const runs: Array<{ start: number; end: number }> = []
  for (let i = text.indexOf('`'); i >= 0; ) {
    let end = i
    while (text[end] === '`') end++
    runs.push({ start: i, end })
    i = text.indexOf('`', end)
  }
  if (runs.length === 0) return []

  // Precomputed so that a thousand unmatched single backticks cost a thousand steps, not a million.
  const nextSameLength = new Array<number>(runs.length).fill(-1)
  const lastByLength = new Map<number, number>()
  for (let k = runs.length - 1; k >= 0; k--) {
    const length = runs[k].end - runs[k].start
    nextSameLength[k] = lastByLength.get(length) ?? -1
    lastByLength.set(length, k)
  }
  const blankLines: number[] = []
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    let j = i + 1
    while (text[j] === ' ' || text[j] === '\t' || text[j] === '\r') j++
    if (text[j] === '\n') blankLines.push(i)
  }

  const ranges: Array<[number, number]> = []
  let blank = 0
  let k = 0
  while (k < runs.length) {
    const run = runs[k]
    const length = run.end - run.start
    if (length >= 3) {
      let close = k + 1
      while (close < runs.length && runs[close].end - runs[close].start < length) close++
      if (close >= runs.length) {
        ranges.push([run.start, text.length])
        break
      }
      ranges.push([run.start, runs[close].end])
      k = close + 1
      continue
    }
    while (blank < blankLines.length && blankLines[blank] < run.end) blank++
    const limit = blank < blankLines.length ? blankLines[blank] : text.length
    const close = nextSameLength[k]
    if (close >= 0 && runs[close].start < limit) {
      ranges.push([run.start, runs[close].end])
      k = close + 1
    } else {
      k++
    }
  }
  return ranges
}
