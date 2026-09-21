/**
 * The condition editor: a form, never a code box.
 *
 * A condition travels inside swarms people paste from each other, so it is data that
 * `engine/predicates.ts` interprets — never code — and the person writing one should not have to know
 * the JSON shape of that data either. Each operator shows the fields it needs and nothing else, groups
 * nest the same form, and a line under it says the whole condition back in English: that line is how
 * you notice "not (any of …)" when you meant "any of (not …)".
 */
import { useState, type ReactNode } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  FormControlLabel,
  FormHelperText,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import {
  describePredicate,
  evaluate,
  MAX_PATTERN_LENGTH,
  MAX_PREDICATE_DEPTH,
  type PredicateContext,
} from '../engine/predicates'
import type { Comparison, CountComparison, Predicate } from '../types'

type Op = Predicate['op']

const OPERATORS: Array<{ op: Op; label: string }> = [
  { op: 'always', label: 'Always' },
  { op: 'contains', label: 'Message contains' },
  { op: 'matches', label: 'Message matches (regex)' },
  { op: 'json', label: 'JSON field' },
  { op: 'memory', label: 'Memory value' },
  { op: 'decision', label: 'Decision answer' },
  { op: 'visits', label: 'Times this has fired' },
  { op: 'round', label: 'Round number' },
  { op: 'all', label: 'All of' },
  { op: 'any', label: 'Any of' },
  { op: 'not', label: 'Not' },
]

const GROUP_OPS: ReadonlySet<Op> = new Set<Op>(['all', 'any', 'not'])

const COMPARISONS: Array<{ cmp: Comparison; label: string }> = [
  { cmp: 'eq', label: '= equals' },
  { cmp: 'neq', label: '≠ differs' },
  { cmp: 'gt', label: '> more than' },
  { cmp: 'gte', label: '≥ at least' },
  { cmp: 'lt', label: '< less than' },
  { cmp: 'lte', label: '≤ at most' },
  { cmp: 'exists', label: 'exists' },
  { cmp: 'contains', label: 'contains' },
]

const COUNT_COMPARISONS: Array<{ cmp: CountComparison; label: string }> = [
  { cmp: 'eq', label: '= exactly' },
  { cmp: 'gt', label: '> more than' },
  { cmp: 'gte', label: '≥ at least' },
  { cmp: 'lt', label: '< fewer than' },
  { cmp: 'lte', label: '≤ at most' },
]

/** The same flags the engine keeps. */
const ALLOWED_FLAGS = 'imsu'

const INDENT: SxProps<Theme> = { pl: 1.5, borderLeft: '2px solid', borderColor: 'divider' }

/**
 * A context in which nothing can go wrong except the condition itself. With an empty message and a
 * memory that answers nothing, the only problems `evaluate` can still report are about the shape: a
 * pattern that does not compile, a repetition of a repetition, an empty path segment, a memory with
 * no name. Those are what the person has to fix before the run, so those are what the form shows.
 */
const EMPTY_CONTEXT: PredicateContext = { text: '', visits: 0, round: 1, readMemory: () => undefined, decision: {} }

function shapeProblem(predicate: Predicate | undefined): string | undefined {
  return evaluate(predicate, EMPTY_CONTEXT).problem
}

/** What "Add condition" inserts: an empty text test, which holds — so adding it never closes a branch by itself. */
function blank(): Predicate {
  return { op: 'contains', value: '' }
}

function isKnown(value: unknown): value is Predicate {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    OPERATORS.some((o) => o.op === (value as { op?: unknown }).op)
  )
}

/** A pasted condition can hold anything where text is expected; a field must not crash on it. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * A value typed as a number is stored as one, so the saved condition reads `"score": 7` and not
 * `"7"`. Only when the text is the number's own spelling: `007` stays text (a text compare must keep
 * its zeros) and so does `1.` — otherwise the dot would vanish under the cursor on the way to `1.5`.
 */
function typedValue(raw: string): string | number {
  const trimmed = raw.trim()
  if (trimmed !== '' && String(Number(trimmed)) === trimmed) return Number(trimmed)
  return raw
}

/** `g` and `y` make a regex stateful between two tests; the engine drops them, so the form refuses them where you can see it. */
function keepFlags(input: string): string {
  let kept = ''
  for (const flag of input) if (ALLOWED_FLAGS.includes(flag) && !kept.includes(flag)) kept += flag
  return kept
}

/**
 * The condition after its operator changed, keeping what still means something.
 *
 * Text carries between "contains" and "matches", a comparison between JSON and memory, a count
 * between visits and round. Choosing a group WRAPS the current condition instead of discarding it:
 * the usual reason to pick "All of" is "this, and also something else". Moving between group kinds
 * keeps the children.
 */
function convert(current: Predicate | undefined, op: Op, memoryNames: string[], decisionPaths: string[]): Predicate {
  const p = isKnown(current) ? current : undefined
  const carriedText = p?.op === 'contains' ? text(p.value) : p?.op === 'matches' ? text(p.pattern) : ''
  const comparison =
    p?.op === 'json' || p?.op === 'memory' || p?.op === 'decision'
      ? { cmp: p.cmp, ...(p.value !== undefined ? { value: p.value } : {}) }
      : { cmp: 'eq' as Comparison, value: '' }
  const count = p?.op === 'visits' || p?.op === 'round' ? { cmp: p.cmp, value: p.value } : undefined
  const children: Predicate[] =
    p === undefined || p.op === 'always'
      ? []
      : p.op === 'all' || p.op === 'any'
        ? Array.isArray(p.of)
          ? p.of
          : []
        : p.op === 'not'
          ? [p.of]
          : [p]

  switch (op) {
    case 'always':
      return { op }
    case 'contains':
      return { op, value: carriedText }
    case 'matches':
      return { op, pattern: carriedText }
    case 'json':
      return { op, path: '', ...comparison }
    case 'memory':
      return { op, memory: memoryNames[0] ?? '', key: '', ...comparison }
    case 'decision':
      return { op, path: decisionPaths[0] ?? '', ...comparison }
    // A critic loop's "fewer than three drafts", and a short run, are the likeliest first intents.
    case 'visits':
      return { op, ...(count ?? { cmp: 'lt' as CountComparison, value: 3 }) }
    case 'round':
      return { op, ...(count ?? { cmp: 'lte' as CountComparison, value: 5 }) }
    case 'all':
    case 'any':
      return { op, of: children.length > 0 ? children : [blank()] }
    case 'not':
      // Negating a group of several negates the group as a whole, rather than keeping only its first child.
      return { op, of: children.length > 1 && p ? p : (children[0] ?? blank()) }
  }
}

export function PredicateEditor({
  value,
  onChange,
  memoryNames,
  decisionPaths = [],
  allowNone = false,
}: {
  value: Predicate | undefined
  onChange: (next: Predicate | undefined) => void
  memoryNames: string[]
  /** Answer paths of the Decision nodes on this graph (`route.choice`), offered for a decision condition. */
  decisionPaths?: string[]
  allowNone?: boolean
}): JSX.Element {
  const problem = shapeProblem(value)
  return (
    <Stack spacing={1}>
      <PredicateFields
        value={value}
        onChange={onChange}
        memoryNames={memoryNames}
        decisionPaths={decisionPaths}
        allowNone={allowNone}
        path={[]}
      />
      {/* One text node on purpose: it is read aloud as it changes, and a split sentence reads as two. */}
      <Typography variant="caption" role="status" sx={{ display: 'block', opacity: 0.75, fontStyle: 'italic' }}>
        {`In words: ${describePredicate(value)}`}
      </Typography>
      {problem && (
        <FormHelperText error sx={{ mt: 0 }}>
          {problem}
        </FormHelperText>
      )}
    </Stack>
  )
}

interface FieldsProps {
  value: Predicate | undefined
  onChange: (next: Predicate | undefined) => void
  memoryNames: string[]
  decisionPaths: string[]
  /** Only the root of a link guard may be "no condition"; a child of a group always is one. */
  allowNone: boolean
  /** 1-based position from the root: `[]` is the root, `[2, 1]` the first child of its second child. */
  path: number[]
}

function PredicateFields({ value, onChange, memoryNames, decisionPaths, allowNone, path }: FieldsProps) {
  const name = path.length === 0 ? 'Condition' : `Condition ${path.join('.')}`
  // `evaluate` counts the root as depth 1 and refuses anything nested past MAX_PREDICATE_DEPTH, so a
  // group is only offered where its children would still be read.
  const groupsAllowed = path.length + 1 < MAX_PREDICATE_DEPTH
  // An unknown operator (a paste from a newer build, a hand edit) selects nothing rather than
  // pretending to be something; the error under the form says what it is.
  const selected = value === undefined ? 'always' : isKnown(value) ? value.op : ''

  const choose = (op: Op) => {
    if (op === 'always' && allowNone) onChange(undefined)
    else onChange(convert(value, op, memoryNames, decisionPaths))
  }

  const fields = (
    <Stack spacing={1.25}>
      <TextField select size="small" label={name} value={selected} onChange={(e) => choose(e.target.value as Op)} fullWidth>
        {OPERATORS.map(({ op, label }) => (
          <MenuItem key={op} value={op} disabled={GROUP_OPS.has(op) && !groupsAllowed}>
            {op === 'always' && allowNone ? 'No condition (always taken)' : label}
          </MenuItem>
        ))}
      </TextField>
      {value !== undefined && isKnown(value) && (
        <OperatorFields value={value} onChange={onChange} memoryNames={memoryNames} decisionPaths={decisionPaths} path={path} />
      )}
    </Stack>
  )
  // Nested conditions repeat the same field names; the group gives each set its own name for a screen reader.
  return path.length === 0 ? (
    fields
  ) : (
    <Box role="group" aria-label={name}>
      {fields}
    </Box>
  )
}

function OperatorFields({
  value,
  onChange,
  memoryNames,
  decisionPaths,
  path,
}: {
  value: Predicate
  onChange: (next: Predicate) => void
  memoryNames: string[]
  decisionPaths: string[]
  path: number[]
}) {
  // A group's problem belongs to one of its children, which marks its own field.
  const invalid = !GROUP_OPS.has(value.op) && shapeProblem(value) !== undefined

  switch (value.op) {
    case 'always':
      return null

    case 'contains':
      return (
        <Box>
          <TextField
            size="small"
            label="Text"
            value={text(value.value)}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            error={invalid}
            fullWidth
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={value.caseSensitive === true}
                onChange={(e) => {
                  const { caseSensitive: _previous, ...rest } = value
                  onChange(e.target.checked ? { ...rest, caseSensitive: true } : rest)
                }}
              />
            }
            label="Case-sensitive"
            slotProps={{ typography: { variant: 'body2' } }}
            sx={{ mt: 0.5 }}
          />
        </Box>
      )

    case 'matches':
      return (
        <Stack spacing={1.25}>
          <TextField
            size="small"
            label="Pattern"
            value={text(value.pattern)}
            onChange={(e) => onChange({ ...value, pattern: e.target.value })}
            error={invalid}
            helperText={`A regular expression, without the slashes · at most ${MAX_PATTERN_LENGTH} characters`}
            slotProps={{
              htmlInput: { spellCheck: false, autoCapitalize: 'off', style: { fontFamily: '"Roboto Mono", monospace' } },
            }}
            fullWidth
          />
          <TextField
            size="small"
            label="Flags"
            value={text(value.flags)}
            onChange={(e) => {
              const flags = keepFlags(e.target.value)
              const { flags: _previous, ...rest } = value
              onChange(flags ? { ...rest, flags } : rest)
            }}
            helperText="i ignore case · m ^ and $ per line · s dot matches newlines · u unicode"
            fullWidth
          />
        </Stack>
      )

    case 'json':
      return (
        <Stack spacing={1.25}>
          <TextField
            size="small"
            label="Field path"
            placeholder="verdict.score"
            value={text(value.path)}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
            error={invalid}
            helperText="Dotted path into the first JSON object of the message; empty = the object itself"
            fullWidth
          />
          <ComparisonRow
            cmp={value.cmp}
            value={value.value}
            onChange={(next) => onChange({ op: 'json', path: value.path, ...next })}
          />
        </Stack>
      )

    case 'memory': {
      const wanted = text(value.memory).trim().toLowerCase()
      // The engine matches memory names trimmed and without case; the warning follows the same rule.
      const found = memoryNames.some((n) => n.trim().toLowerCase() === wanted)
      return (
        <Stack spacing={1.25}>
          <Autocomplete
            freeSolo
            size="small"
            options={memoryNames}
            value={text(value.memory)}
            // Only the input event: picking an option reports its text there too, and handling both
            // would write the same change twice — two undo steps for one click.
            onInputChange={(_, next) => {
              if (next !== value.memory) onChange({ ...value, memory: next })
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Memory"
                error={invalid}
                helperText={
                  memoryNames.length === 0
                    ? 'No memory node in this graph yet'
                    : wanted && !found
                      ? 'No memory by that name here: its value will read as missing'
                      : undefined
                }
              />
            )}
          />
          <TextField
            size="small"
            label="Key"
            value={text(value.key)}
            onChange={(e) => onChange({ ...value, key: e.target.value })}
            helperText="A log answers with its newest entry under this key; a document ignores it"
            fullWidth
          />
          <ComparisonRow
            cmp={value.cmp}
            value={value.value}
            onChange={(next) => onChange({ op: 'memory', memory: value.memory, key: value.key, ...next })}
          />
        </Stack>
      )
    }

    case 'decision': {
      const typed = text(value.path).trim()
      return (
        <Stack spacing={1.25}>
          <Autocomplete
            freeSolo
            size="small"
            options={decisionPaths}
            value={text(value.path)}
            onInputChange={(_, next) => {
              if (next !== value.path) onChange({ ...value, path: next })
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Answer"
                placeholder="route.choice"
                error={invalid}
                helperText={
                  decisionPaths.length === 0
                    ? 'No Decision node in this graph yet'
                    : typed && !decisionPaths.includes(typed) && !typed.includes('.probabilities.')
                      ? 'Not an answer of any Decision node here: it will read as missing'
                      : 'question.choice / .confidence (choice) · .yes / .noul (yes-no) · .score / .level (score)'
                }
              />
            )}
          />
          <ComparisonRow
            cmp={value.cmp}
            value={value.value}
            onChange={(next) => onChange({ op: 'decision', path: value.path, ...next })}
          />
        </Stack>
      )
    }

    case 'visits':
    case 'round': {
      const current = value
      return (
        <Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              select
              size="small"
              label="Comparison"
              value={current.cmp}
              onChange={(e) => onChange({ ...current, cmp: e.target.value as CountComparison })}
              sx={{ width: 150, flexShrink: 0 }}
            >
              {COUNT_COMPARISONS.map(({ cmp, label }) => (
                <MenuItem key={cmp} value={cmp}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
            <NumberField
              size="small"
              label={current.op === 'visits' ? 'Times' : 'Round'}
              value={typeof current.value === 'number' ? current.value : undefined}
              min={0}
              error={invalid}
              onChange={(next) => {
                if (next !== undefined) onChange({ ...current, value: next })
              }}
            />
          </Box>
          <Caption sx={{ mt: 0.5 }}>
            {current.op === 'visits'
              ? 'Earlier firings in this run — of the link, for a guard; of the node, for a condition.'
              : 'The round the message is delivered in, counting from 1.'}
          </Caption>
        </Box>
      )
    }

    case 'all':
    case 'any': {
      const group = value
      const children = Array.isArray(group.of) ? group.of : []
      const replace = (index: number, next: Predicate | undefined) =>
        onChange({ ...group, of: children.map((child, i) => (i === index ? (next ?? blank()) : child)) })
      return (
        <Stack spacing={1.25} sx={INDENT}>
          {children.map((child, index) => {
            const childPath = [...path, index + 1]
            return (
              <Box key={index} sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <PredicateFields
                    value={child}
                    onChange={(next) => replace(index, next)}
                    memoryNames={memoryNames}
                    decisionPaths={decisionPaths}
                    allowNone={false}
                    path={childPath}
                  />
                </Box>
                <Tooltip title="Remove this condition">
                  <IconButton
                    size="small"
                    aria-label={`Remove condition ${childPath.join('.')}`}
                    onClick={() => onChange({ ...group, of: children.filter((_, i) => i !== index) })}
                    sx={{ mt: 0.5 }}
                  >
                    <DeleteOutlineRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            )
          })}
          {children.length === 0 && (
            // Said out loud because the two empty groups mean opposite things.
            <Caption>{group.op === 'all' ? 'Empty: always true.' : 'Empty: never true — this blocks the way.'}</Caption>
          )}
          <Button
            size="small"
            startIcon={<AddRoundedIcon />}
            onClick={() => onChange({ ...group, of: [...children, blank()] })}
            aria-label={path.length === 0 ? undefined : `Add condition to condition ${path.join('.')}`}
            sx={{ alignSelf: 'flex-start' }}
          >
            Add condition
          </Button>
        </Stack>
      )
    }

    case 'not': {
      const negation = value
      return (
        <Box sx={INDENT}>
          {/* Exactly one child, so no add and no remove: to drop the "not", change the operator above. */}
          <PredicateFields
            value={negation.of}
            onChange={(next) => onChange({ op: 'not', of: next ?? blank() })}
            memoryNames={memoryNames}
            decisionPaths={decisionPaths}
            allowNone={false}
            path={[...path, 1]}
          />
        </Box>
      )
    }
  }
}

/** Comparison and value, shared by the JSON and memory operators because the engine compares both the same way. */
function ComparisonRow({
  cmp,
  value,
  onChange,
}: {
  cmp: Comparison
  value: string | number | boolean | undefined
  onChange: (next: { cmp: Comparison; value?: string | number | boolean }) => void
}) {
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      <TextField
        select
        size="small"
        label="Comparison"
        value={cmp}
        // `exists` takes no value, and a leftover one would sit in the saved JSON meaning nothing.
        onChange={(e) => {
          const next = e.target.value as Comparison
          onChange(next === 'exists' ? { cmp: next } : { cmp: next, value: value ?? '' })
        }}
        sx={{ width: 150, flexShrink: 0 }}
      >
        {COMPARISONS.map((option) => (
          <MenuItem key={option.cmp} value={option.cmp}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
      {cmp !== 'exists' && (
        <TextField
          size="small"
          label="Value"
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange({ cmp, value: typedValue(e.target.value) })}
          helperText={typeof value === 'number' ? 'Compared as a number' : undefined}
          fullWidth
        />
      )}
    </Box>
  )
}

/**
 * A number input you can type through.
 *
 * Committing each keystroke under a floor (200 characters, say) would turn the "2" of "2400" into
 * 200 before the second key lands. So while the field has focus it shows what you typed and the
 * store receives the nearest valid number; once focus leaves, it shows the store again. Empty means
 * "unset" where `allowEmpty` says so, and is otherwise ignored until a number arrives.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  allowEmpty = false,
  helperText,
  placeholder,
  error,
  size,
  sx,
}: {
  label: string
  value: number | undefined
  onChange: (next: number | undefined) => void
  min?: number
  allowEmpty?: boolean
  helperText?: ReactNode
  placeholder?: string
  error?: boolean
  size?: 'small' | 'medium'
  sx?: SxProps<Theme>
}) {
  // `null` = not focused: show the stored value.
  const [draft, setDraft] = useState<string | null>(null)
  const stored = value === undefined ? '' : String(value)
  return (
    <TextField
      label={label}
      type="number"
      size={size}
      value={draft ?? stored}
      placeholder={placeholder}
      helperText={helperText}
      error={error}
      onFocus={() => setDraft(stored)}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        const raw = event.target.value
        if (draft !== null) setDraft(raw)
        const trimmed = raw.trim()
        if (trimmed === '') {
          if (allowEmpty && value !== undefined) onChange(undefined)
          return
        }
        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed)) return
        // Every count here is whole: rounds, messages, characters.
        const next = Math.max(min ?? -Infinity, Math.floor(parsed))
        if (next !== value) onChange(next)
      }}
      slotProps={{ htmlInput: { min, step: 1, inputMode: 'numeric' } }}
      fullWidth
      sx={sx}
    />
  )
}

/** The panel's small print, in the same voice as the agent inspector's captions. */
export function Caption({
  children,
  tone,
  sx,
}: {
  children: ReactNode
  tone?: 'warning' | 'error'
  sx?: SxProps<Theme>
}) {
  return (
    <Typography
      variant="caption"
      sx={[
        { display: 'block', opacity: tone ? 1 : 0.6, color: tone ? `${tone}.main` : undefined },
        ...(sx === undefined ? [] : Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Typography>
  )
}
