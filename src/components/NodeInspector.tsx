/**
 * Inspectors for what the agent inspector does not cover: every other kind of node, a selected link,
 * and the graph side of an agent (how it hands on its message, whether it may spawn, which memories
 * it reaches).
 *
 * Every control writes through the store's actions, and clearing a field writes `undefined`: a saved
 * or shared swarm should carry the settings someone chose, not a trail of empty defaults.
 */
import type { ReactNode } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import LinkOffRoundedIcon from '@mui/icons-material/LinkOffRounded'
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded'
import { allBlocks, useGraph, useStore } from '../store'
import { accessEnds, accessGranted, canRead, canWrite, messageLinks, nameOfNode, nodesOf } from '../engine/graph'
import { modelForProvider, PROVIDERS } from '../engine/providers'
import { DECISION_PROVIDERS, decisionKey, decisionProviderInfo, questionProblems } from '../engine/decisions'
import type {
  Access,
  BlockNode,
  ConditionNode,
  DecisionNode,
  DecisionProviderId,
  DecisionQuestion,
  DecisionQuestionType,
  Dispatch,
  FlowNode,
  Graph,
  HumanNode,
  JoinNode,
  Link,
  MemoryEntry,
  MemoryMode,
  MemoryNode,
  ProviderId,
} from '../types'
import { Caption, NumberField, PredicateEditor } from './PredicateEditor'

const KIND_TITLES: Record<FlowNode['kind'], string> = {
  condition: 'CONDITION',
  join: 'JOIN',
  output: 'OUTPUT',
  human: 'HUMAN GATE',
  memory: 'MEMORY',
  block: 'BLOCK',
  decision: 'DECISION',
}

const KIND_NOUNS: Record<FlowNode['kind'], string> = {
  condition: 'condition',
  join: 'join',
  output: 'output',
  human: 'gate',
  memory: 'memory',
  block: 'block',
  decision: 'decision',
}

const MEMORY_MODES: Array<{ mode: MemoryMode; label: string; meaning: string }> = [
  { mode: 'blackboard', label: 'Blackboard', meaning: 'Shared keys, latest value wins.' },
  { mode: 'log', label: 'Log', meaning: 'Append-only feed.' },
  { mode: 'document', label: 'Document', meaning: 'One text, rewritten whole, versioned.' },
]

const DISPATCHES: Array<{ value: Dispatch; label: string }> = [
  { value: 'inherit', label: 'Follow the swarm topology' },
  { value: 'all', label: 'Every link' },
  { value: 'rotate', label: 'Rotate one link per turn' },
  { value: 'choose', label: 'Choose its branch' },
]

const BLOCK_SOURCES = { swarm: 'Embedded in this swarm', saved: 'Saved in this browser', builtin: 'Built-in' } as const

/** The answers a guard can read, for every Decision node on this graph: what the editor offers. */
function decisionPathsOf(graph: Graph): string[] {
  const paths: string[] = []
  for (const node of nodesOf(graph)) {
    if (node.kind !== 'decision') continue
    for (const q of node.questions ?? []) {
      if (q.type === 'choice') paths.push(`${q.name}.choice`, `${q.name}.confidence`)
      else if (q.type === 'noul') paths.push(`${q.name}.yes`, `${q.name}.noul`)
      else paths.push(`${q.name}.score`, `${q.name}.level`, `${q.name}.confidence`)
    }
  }
  return [...new Set(paths)]
}

/** A predicate reads a memory by NAME, so the names on this graph are what the editor offers. */
function memoryNamesOf(graph: Graph): string[] {
  return nodesOf(graph)
    .filter((n) => n.kind === 'memory')
    .map((n) => n.name)
}

function rights(read: boolean, write: boolean): string {
  return read && write ? 'reads & writes' : read ? 'reads' : 'writes'
}

/** A section title, in the agent inspector's small caption style. */
function Label({ children }: { children: ReactNode }) {
  return (
    <Typography variant="caption" sx={{ opacity: 0.7, display: 'block', mb: 0.75 }}>
      {children}
    </Typography>
  )
}

/* ------------------------------------------------------------------------------------------------ */
/* Nodes                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export function NodeInspector({ nodeId }: { nodeId: string }): JSX.Element | null {
  const graph = useGraph()
  const updateNode = useStore((s) => s.updateNode)
  const removeAgents = useStore((s) => s.removeAgents)
  const toggleEntry = useStore((s) => s.toggleEntry)

  const node = nodesOf(graph).find((n) => n.id === nodeId)
  if (!node) return null
  const receivesTask = graph.entryIds.includes(node.id)

  return (
    <Stack spacing={2.25} sx={{ p: 2, overflowY: 'auto' }}>
      <Typography variant="subtitle2" sx={{ opacity: 0.7 }}>
        {KIND_TITLES[node.kind]}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TextField label="Name" value={node.name} onChange={(e) => updateNode(node.id, { name: e.target.value })} fullWidth />
        <Tooltip title={`Delete this ${KIND_NOUNS[node.kind]}`}>
          <IconButton
            onClick={() => removeAgents([node.id])}
            size="small"
            aria-label={`Delete ${KIND_NOUNS[node.kind]} ${node.name}`}
          >
            <DeleteOutlineRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {node.kind === 'condition' && <ConditionSection node={node} graph={graph} />}
      {node.kind === 'join' && <JoinSection node={node} />}
      {node.kind === 'output' && (
        <Caption>What reaches here is the result of this graph — what a block returns to its parent.</Caption>
      )}
      {node.kind === 'human' && <HumanSection node={node} />}
      {node.kind === 'memory' && <MemorySection node={node} graph={graph} />}
      {node.kind === 'block' && <BlockSection node={node} />}
      {node.kind === 'decision' && <DecisionSection node={node} />}

      {/* Only the kinds that can sensibly start a run: a block runs its graph on the task, a
          condition routes it. A join, a gate or a memory handed the task would have nothing to do. */}
      {(node.kind === 'condition' || node.kind === 'block' || node.kind === 'decision') && (
        <Box>
          <Chip
            size="small"
            icon={<BoltRoundedIcon />}
            label={receivesTask ? 'Receives the task' : 'Make it receive the task'}
            color={receivesTask ? 'primary' : 'default'}
            variant={receivesTask ? 'filled' : 'outlined'}
            onClick={() => toggleEntry(node.id)}
          />
          <Caption sx={{ mt: 1 }}>With none marked, every agent or block that has no incoming link starts the run.</Caption>
        </Box>
      )}
    </Stack>
  )
}

function ConditionSection({ node, graph }: { node: ConditionNode; graph: Graph }) {
  const updateNode = useStore((s) => s.updateNode)
  return (
    <Stack spacing={1}>
      <PredicateEditor
        value={node.predicate}
        // A condition node always has a predicate: "no condition" on a node can only mean "always".
        onChange={(next) => updateNode(node.id, { predicate: next ?? { op: 'always' } })}
        memoryNames={memoryNamesOf(graph)}
        decisionPaths={decisionPathsOf(graph)}
      />
      <Caption>Links out of a condition are labelled true / false; an unlabelled one counts as true.</Caption>
    </Stack>
  )
}

function JoinSection({ node }: { node: JoinNode }) {
  const updateNode = useStore((s) => s.updateNode)
  return (
    <>
      <TextField
        select
        label="Mode"
        value={node.mode}
        onChange={(e) => updateNode(node.id, { mode: e.target.value as JoinNode['mode'] })}
        helperText={
          node.mode === 'all'
            ? 'Holds what arrives, then sends one combined message once every branch that ran has delivered.'
            : 'Sends the first arrival on and drops the rest of that wave.'
        }
        fullWidth
      >
        <MenuItem value="all">All — wait for every branch</MenuItem>
        <MenuItem value="any">Any — first arrival wins</MenuItem>
      </TextField>
      {/* The engine only times out a join that waits: offering the field on `any` would be a knob
          connected to nothing. */}
      {node.mode === 'all' && (
        <NumberField
          label="Stop waiting after N rounds"
          value={node.timeoutRounds}
          min={1}
          allowEmpty
          placeholder="Never"
          onChange={(next) => updateNode(node.id, { timeoutRounds: next })}
          helperText="Empty = never. When it expires, whatever it holds goes on, with a notice."
        />
      )}
    </>
  )
}

function HumanSection({ node }: { node: HumanNode }) {
  const updateNode = useStore((s) => s.updateNode)
  return (
    <>
      <TextField
        label="Prompt"
        value={node.prompt}
        onChange={(e) => updateNode(node.id, { prompt: e.target.value })}
        helperText="What the person is asked when a message reaches this gate"
        multiline
        minRows={2}
        fullWidth
      />
      <Caption>
        The run pauses here. Approve sends the message, edited or not, on the links labelled approved; Reject on
        those labelled rejected. An unlabelled link counts as approved.
      </Caption>
    </>
  )
}

function MemorySection({ node, graph }: { node: MemoryNode; graph: Graph }) {
  const updateNode = useStore((s) => s.updateNode)
  const connected = graph.agents
    .map((agent) => ({ agent, read: canRead(graph, agent.id, node.id), write: canWrite(graph, agent.id, node.id) }))
    .filter((c) => c.read || c.write)

  return (
    <>
      <TextField
        select
        label="Mode"
        value={node.mode}
        onChange={(e) => updateNode(node.id, { mode: e.target.value as MemoryMode })}
        helperText={MEMORY_MODES.find((m) => m.mode === node.mode)?.meaning}
        slotProps={{
          // Closed, the field shows the name only: the meaning is already right under it.
          select: { renderValue: (value) => MEMORY_MODES.find((m) => m.mode === value)?.label ?? String(value) },
        }}
        fullWidth
      >
        {MEMORY_MODES.map((m) => (
          <MenuItem key={m.mode} value={m.mode}>
            <Box>
              <Typography variant="body2">{m.label}</Typography>
              <Typography variant="caption" sx={{ display: 'block', opacity: 0.65 }}>
                {m.meaning}
              </Typography>
            </Box>
          </MenuItem>
        ))}
      </TextField>

      <FormControlLabel
        control={
          <Switch checked={node.wakeReaders} onChange={(e) => updateNode(node.id, { wakeReaders: e.target.checked })} />
        }
        label="Wake readers on every write (bus)"
      />

      <NumberField
        label="Characters a reader sees per turn"
        value={node.maxChars}
        min={200}
        onChange={(next) => {
          if (next !== undefined) updateNode(node.id, { maxChars: next })
        }}
        helperText="Past it, the entries least related to the conversation are left out, and counted."
      />

      <SeedEditor node={node} />

      <Caption>Draw a link agent → memory to let it write, memory → agent to let it read, both for both.</Caption>

      <Box>
        <Label>Who reaches it now · {connected.length}</Label>
        {connected.length === 0 ? (
          <Caption>No agent is connected yet.</Caption>
        ) : (
          <Stack spacing={0.5}>
            {connected.map(({ agent, read, write }) => (
              <Box key={agent.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {agent.name}
                </Typography>
                <Chip size="small" variant="outlined" label={rights(read, write)} />
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </>
  )
}

/** Stamped like a write, so the engine renders a seed like any other entry: by "seed", before round 1. */
function seedEntry(): MemoryEntry {
  return { key: '', value: '', author: 'seed', round: 0, version: 1 }
}

function SeedEditor({ node }: { node: MemoryNode }) {
  const updateNode = useStore((s) => s.updateNode)
  const seed = Array.isArray(node.seed) ? node.seed : []
  const setSeed = (next: MemoryEntry[]) => updateNode(node.id, { seed: next })

  if (node.mode === 'document') {
    // A document is one text: the engine reads its LAST entry, so that is the one shown and edited.
    const last = seed.at(-1)
    return (
      <Box>
        <TextField
          label="Seed text"
          value={last?.value ?? ''}
          onChange={(e) =>
            setSeed(e.target.value === '' ? [] : [{ ...(last ?? seedEntry()), key: '', value: e.target.value }])
          }
          helperText="The document as it stands before the run. An agent that writes it replaces it whole."
          multiline
          minRows={4}
          fullWidth
        />
        {seed.length > 1 && (
          <Caption tone="warning" sx={{ mt: 0.75 }}>
            Only the last of these {seed.length} seed entries is the document; editing it keeps that one alone.
          </Caption>
        )}
      </Box>
    )
  }

  const put = (index: number, patch: Partial<Pick<MemoryEntry, 'key' | 'value'>>) =>
    setSeed(seed.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))

  return (
    <Box>
      <Label>Seed · {seed.length}</Label>
      {seed.length === 0 && <Caption>Nothing is loaded before the run. Add reference material, rules, a glossary.</Caption>}
      <Stack spacing={1.5}>
        {seed.map((entry, index) => (
          <Box key={index} sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
            <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
              <TextField
                size="small"
                // A log entry is found by its key too, but a log line does not need one to be read.
                label={node.mode === 'log' ? 'Key (optional)' : 'Key'}
                value={entry.key}
                onChange={(e) => put(index, { key: e.target.value })}
                slotProps={{ htmlInput: { 'aria-label': `Seed entry ${index + 1} key` } }}
                fullWidth
              />
              <TextField
                size="small"
                label="Value"
                value={entry.value}
                onChange={(e) => put(index, { value: e.target.value })}
                slotProps={{ htmlInput: { 'aria-label': `Seed entry ${index + 1} value` } }}
                multiline
                minRows={2}
                fullWidth
              />
            </Stack>
            <Tooltip title="Remove this entry">
              <IconButton
                size="small"
                aria-label={`Remove seed entry ${index + 1}`}
                onClick={() => setSeed(seed.filter((_, i) => i !== index))}
              >
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        ))}
      </Stack>
      <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => setSeed([...seed, seedEntry()])} sx={{ mt: 1 }}>
        Add entry
      </Button>
    </Box>
  )
}

function BlockSection({ node }: { node: BlockNode }) {
  const spec = useStore((s) => s.spec)
  const library = useStore((s) => s.library)
  const updateNode = useStore((s) => s.updateNode)
  const openBlock = useStore((s) => s.openBlock)
  const detachBlock = useStore((s) => s.detachBlock)

  const def = allBlocks(spec, library).find((b) => b.id === node.blockId)
  const provider = node.overrides?.provider
  const model = node.overrides?.model ?? ''

  // `overrides` exists only while it overrides something: an empty object would make a shared swarm
  // look customised for nothing, and the portable reader drops it anyway.
  const setOverrides = (next: { provider?: ProviderId; model?: string }) => {
    const clean: NonNullable<BlockNode['overrides']> = {}
    if (next.provider) clean.provider = next.provider
    if (next.model && next.model.trim() !== '') clean.model = next.model
    updateNode(node.id, { overrides: Object.keys(clean).length > 0 ? clean : undefined })
  }

  return (
    <>
      <Box>
        <Label>Runs</Label>
        {def ? (
          <>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {def.name}
            </Typography>
            {def.description && (
              <Typography variant="body2" sx={{ opacity: 0.75 }}>
                {def.description}
              </Typography>
            )}
            <Caption sx={{ mt: 0.5 }}>{BLOCK_SOURCES[def.source]}</Caption>
          </>
        ) : (
          <Caption tone="error">
            Its definition ({node.blockId}) is not in this swarm, this browser or the built-ins, so it cannot run.
          </Caption>
        )}
      </Box>

      <Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<OpenInFullRoundedIcon />}
            disabled={!def}
            onClick={() => openBlock(node.blockId)}
          >
            Open inside
          </Button>
          <Button size="small" startIcon={<CallSplitRoundedIcon />} disabled={!def} onClick={() => detachBlock(node.id)}>
            Detach into agents
          </Button>
        </Box>
        <Caption sx={{ mt: 1 }}>
          Editing the inside changes every instance of this block. Detaching replaces this one with an editable copy of
          its graph.
        </Caption>
      </Box>

      <TextField
        select
        label="Provider for every agent inside"
        value={provider ?? 'inherit'}
        onChange={(e) => {
          const value = e.target.value
          if (value === 'inherit') return setOverrides({ model })
          const next = value as ProviderId
          // As when an agent switches provider: a demo model id means nothing to a real endpoint, so an
          // empty model override is filled with the provider's first suggestion.
          setOverrides({ provider: next, model: model.trim() ? model : modelForProvider(next, '') })
        }}
        fullWidth
      >
        <MenuItem value="inherit">Inherit — each agent keeps its own</MenuItem>
        {PROVIDERS.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.label}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        label="Model for every agent inside"
        value={model}
        onChange={(e) => setOverrides({ provider, model: e.target.value })}
        helperText={
          provider && model.trim() === ''
            ? 'Empty: the agents keep their own model ids, which may not exist on this provider'
            : 'Empty = each agent keeps its own model'
        }
        error={Boolean(provider) && provider !== 'mock' && model.trim() === ''}
        fullWidth
      />

      <Caption>A block can contain itself. Nested runs share the swarm's round budget and stop at the depth limit.</Caption>
    </>
  )
}

const QUESTION_TYPES: Array<{ type: DecisionQuestionType; label: string; meaning: string }> = [
  { type: 'choice', label: 'Choice', meaning: 'Picks one label. Answers choice, confidence and a probability per label.' },
  { type: 'noul', label: 'Yes / no', meaning: 'Answers the probability of yes (noul), and yes = true when it is at least 0.5.' },
  { type: 'score', label: 'Score', meaning: 'Rates on ordered levels, lowest first. Answers the expected level, its name and a confidence.' },
]

function newQuestion(taken: string[]): DecisionQuestion {
  let name = 'question'
  for (let i = 2; taken.includes(name); i++) name = `question${i}`
  return {
    name,
    type: 'choice',
    instructions: '',
    options: [
      { label: 'yes', criterion: '' },
      { label: 'no', criterion: '' },
    ],
  }
}

/** The question after its type changed, keeping what still applies. */
function retype(question: DecisionQuestion, type: DecisionQuestionType): DecisionQuestion {
  const { options: _options, levels: _levels, ...rest } = question
  if (type === 'score') return { ...rest, type, levels: question.levels?.length ? question.levels : ['low', 'medium', 'high'] }
  if (type === 'noul') return { ...rest, type }
  return {
    ...rest,
    type,
    options: question.options?.length ? question.options : [{ label: 'yes', criterion: '' }, { label: 'no', criterion: '' }],
  }
}

function DecisionSection({ node }: { node: DecisionNode }) {
  const updateNode = useStore((s) => s.updateNode)
  const keys = useStore((s) => s.keys)
  const questions = Array.isArray(node.questions) ? node.questions : []
  const info = decisionProviderInfo(node.provider)
  const problems = questionProblems(questions)
  const missingKey = node.provider !== 'mock' && !info.keyOptional && decisionKey(node.provider, keys) === ''
  const setQuestions = (next: DecisionQuestion[]) => updateNode(node.id, { questions: next })
  const put = (index: number, next: DecisionQuestion) => setQuestions(questions.map((q, i) => (i === index ? next : q)))

  return (
    <>
      <Caption>
        A decision model answers typed questions about what reaches it. It writes no text: it forwards the message with
        its answers attached, and the conditions on its outgoing links route on them.
      </Caption>

      <TextField
        select
        label="Decision provider"
        value={node.provider}
        onChange={(e) => {
          const provider = e.target.value as DecisionProviderId
          updateNode(node.id, { provider, model: decisionProviderInfo(provider).models[0] ?? '' })
        }}
        helperText={info.hint}
        fullWidth
      >
        {DECISION_PROVIDERS.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.label}
          </MenuItem>
        ))}
      </TextField>

      <Autocomplete
        freeSolo
        options={info.models}
        value={node.model}
        onInputChange={(_, next) => {
          if (next !== node.model) updateNode(node.id, { model: next })
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Model"
            error={node.provider !== 'mock' && node.model.trim() === ''}
            helperText="Free text: any model that speaks the same typed-question API"
          />
        )}
      />

      {missingKey && (
        <Alert severity="warning" variant="outlined">
          No {info.keyLabel.replace(/ \(.*\)$/, '')} yet. Add it in Settings → Providers, or the run will stop here.
        </Alert>
      )}

      <Box>
        <Label>Questions · {questions.length}</Label>
        <Stack spacing={2}>
          {questions.map((question, index) => (
            <QuestionEditor
              key={index}
              index={index}
              question={question}
              onChange={(next) => put(index, next)}
              onRemove={() => setQuestions(questions.filter((_, i) => i !== index))}
            />
          ))}
        </Stack>
        <Button
          size="small"
          startIcon={<AddRoundedIcon />}
          onClick={() => setQuestions([...questions, newQuestion(questions.map((q) => q.name))])}
          sx={{ mt: 1 }}
        >
          Add question
        </Button>
      </Box>

      {problems.length > 0 && (
        <Stack spacing={0.25}>
          {problems.map((p) => (
            <Caption key={p} tone="error">
              {p}
            </Caption>
          ))}
        </Stack>
      )}

      <Caption>
        Route with a condition on each outgoing link: Decision answer route.choice = billing, route.confidence &lt; 0.6,
        blocked.yes = true. Mark one link Default branch to catch whatever no other link takes.
      </Caption>
    </>
  )
}

function QuestionEditor({
  index,
  question,
  onChange,
  onRemove,
}: {
  index: number
  question: DecisionQuestion
  onChange: (next: DecisionQuestion) => void
  onRemove: () => void
}) {
  const options = question.options ?? []
  const levels = question.levels ?? []
  const n = index + 1
  return (
    <Box role="group" aria-label={`Question ${n}`} sx={{ pl: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}>
      <Stack spacing={1.25}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
          <TextField
            size="small"
            label="Name"
            value={question.name}
            onChange={(e) => onChange({ ...question, name: e.target.value.replace(/\s+/g, '_') })}
            slotProps={{ htmlInput: { 'aria-label': `Question ${n} name`, spellCheck: false, style: { fontFamily: '"Roboto Mono", monospace' } } }}
            sx={{ flex: 1 }}
          />
          <TextField
            select
            size="small"
            label="Type"
            value={question.type}
            onChange={(e) => onChange(retype(question, e.target.value as DecisionQuestionType))}
            sx={{ width: 130, flexShrink: 0 }}
          >
            {QUESTION_TYPES.map((t) => (
              <MenuItem key={t.type} value={t.type}>
                {t.label}
              </MenuItem>
            ))}
          </TextField>
          <Tooltip title="Remove this question">
            <IconButton size="small" aria-label={`Remove question ${n}`} onClick={onRemove} sx={{ mt: 0.5 }}>
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Caption>{QUESTION_TYPES.find((t) => t.type === question.type)?.meaning}</Caption>
        <TextField
          size="small"
          label="Instructions"
          value={question.instructions}
          onChange={(e) => onChange({ ...question, instructions: e.target.value })}
          placeholder={question.type === 'noul' ? 'Is the customer blocked right now?' : 'Which team should answer this?'}
          slotProps={{ htmlInput: { 'aria-label': `Question ${n} instructions` } }}
          multiline
          fullWidth
        />

        {question.type === 'choice' && (
          <Stack spacing={1}>
            {options.map((option, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
                <TextField
                  size="small"
                  label="Label"
                  value={option.label}
                  onChange={(e) => onChange({ ...question, options: options.map((o, j) => (j === i ? { ...o, label: e.target.value } : o)) })}
                  slotProps={{ htmlInput: { 'aria-label': `Question ${n} option ${i + 1} label` } }}
                  sx={{ width: 110, flexShrink: 0 }}
                />
                <TextField
                  size="small"
                  label="When"
                  value={option.criterion}
                  onChange={(e) => onChange({ ...question, options: options.map((o, j) => (j === i ? { ...o, criterion: e.target.value } : o)) })}
                  slotProps={{ htmlInput: { 'aria-label': `Question ${n} option ${i + 1} criterion` } }}
                  fullWidth
                />
                <Tooltip title="Remove this option">
                  <IconButton
                    size="small"
                    aria-label={`Remove option ${i + 1} of question ${n}`}
                    onClick={() => onChange({ ...question, options: options.filter((_, j) => j !== i) })}
                  >
                    <DeleteOutlineRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
            <Button
              size="small"
              startIcon={<AddRoundedIcon />}
              onClick={() => onChange({ ...question, options: [...options, { label: '', criterion: '' }] })}
              sx={{ alignSelf: 'flex-start' }}
            >
              Add option
            </Button>
          </Stack>
        )}

        {question.type === 'noul' &&
          (['true', 'false'] as const).map((side) => {
            const current = options.find((o) => o.label === side)?.criterion ?? ''
            return (
              <TextField
                key={side}
                size="small"
                label={side === 'true' ? 'Yes means (optional)' : 'No means (optional)'}
                value={current}
                onChange={(e) => {
                  const rest = options.filter((o) => o.label !== side)
                  const next = e.target.value ? [...rest, { label: side, criterion: e.target.value }] : rest
                  const { options: _previous, ...base } = question
                  onChange(next.length > 0 ? { ...base, options: next } : base)
                }}
                fullWidth
              />
            )
          })}

        {question.type === 'score' && (
          <Stack spacing={1}>
            {levels.map((level, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                <TextField
                  size="small"
                  label={i === 0 ? 'Level 0 (lowest)' : `Level ${i}`}
                  value={level}
                  onChange={(e) => onChange({ ...question, levels: levels.map((l, j) => (j === i ? e.target.value : l)) })}
                  fullWidth
                />
                <Tooltip title="Remove this level">
                  <IconButton
                    size="small"
                    aria-label={`Remove level ${i} of question ${n}`}
                    onClick={() => onChange({ ...question, levels: levels.filter((_, j) => j !== i) })}
                  >
                    <DeleteOutlineRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
            <Button
              size="small"
              startIcon={<AddRoundedIcon />}
              onClick={() => onChange({ ...question, levels: [...levels, ''] })}
              sx={{ alignSelf: 'flex-start' }}
            >
              Add level
            </Button>
          </Stack>
        )}
      </Stack>
    </Box>
  )
}

/* ------------------------------------------------------------------------------------------------ */
/* Links                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export function LinkInspector({ linkId }: { linkId: string }): JSX.Element | null {
  const graph = useGraph()
  const removeLink = useStore((s) => s.removeLink)

  const link = graph.links.find((l) => l.id === linkId)
  if (!link) return null
  const ends = `${nameOfNode(graph, link.source)} → ${nameOfNode(graph, link.target)}`

  return (
    <Stack spacing={2.25} sx={{ p: 2, overflowY: 'auto' }}>
      <Typography variant="subtitle2" sx={{ opacity: 0.7 }}>
        {link.kind === 'access' ? 'ACCESS LINK' : 'LINK'}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body1" noWrap title={ends} sx={{ flex: 1, minWidth: 0 }}>
          {ends}
        </Typography>
        <Button size="small" color="error" startIcon={<LinkOffRoundedIcon />} onClick={() => removeLink(link.id)}>
          Cut link
        </Button>
      </Box>

      {link.kind === 'access' ? <AccessFields link={link} graph={graph} /> : <MessageLinkFields link={link} graph={graph} />}
    </Stack>
  )
}

function AccessFields({ link, graph }: { link: Link; graph: Graph }) {
  const updateLink = useStore((s) => s.updateLink)
  const ends = accessEnds(graph, link)
  // Without an explicit `access`, the direction decides; the select shows what the engine will grant.
  const granted: Access = ends ? accessGranted(link, ends.memory.id) : (link.access ?? 'read')

  return (
    <>
      <TextField
        select
        label="Access"
        value={granted}
        onChange={(e) => updateLink(link.id, { access: e.target.value as Access })}
        fullWidth
      >
        <MenuItem value="read">Read — sees the memory every turn</MenuItem>
        <MenuItem value="write">Write — may write to it</MenuItem>
        <MenuItem value="readwrite">Read & write</MenuItem>
      </TextField>
      {ends ? (
        <Caption>
          A reader finds {ends.memory.name} in its instructions every turn, cut to the memory's size; a writer is taught
          how to write to it. Without access, an agent neither sees a memory nor writes it.
        </Caption>
      ) : (
        <Caption tone="warning">This link does not join an agent and a memory, so it grants nothing.</Caption>
      )}
    </>
  )
}

function MessageLinkFields({ link, graph }: { link: Link; graph: Graph }) {
  const updateLink = useStore((s) => s.updateLink)
  const fromDecision = nodesOf(graph).find((n) => n.id === link.source)?.kind === 'decision'
  return (
    <>
      <TextField
        label="Label"
        value={link.label ?? ''}
        // Empty removes the key: an empty label would still count as "labelled" for a `choose` agent.
        onChange={(e) => updateLink(link.id, { label: e.target.value === '' ? undefined : e.target.value })}
        helperText={
          'The branch name. An agent set to choose its branch names it with <route to="label"/>; a condition uses true/false; a human gate approved/rejected.'
        }
        fullWidth
      />

      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={link.isDefault === true}
              onChange={(e) => updateLink(link.id, { isDefault: e.target.checked ? true : undefined })}
            />
          }
          label="Default branch"
        />
        <Caption>
          {fromDecision
            ? 'Taken only when no other link out of this Decision node matches: the else branch, where an unsure answer escalates.'
            : 'Taken when an agent that chooses its branch names none that exists.'}
        </Caption>
      </Box>

      <Box>
        <Label>Condition on this link</Label>
        <PredicateEditor
          value={link.guard}
          onChange={(next) => updateLink(link.id, { guard: next })}
          memoryNames={memoryNamesOf(graph)}
          decisionPaths={decisionPathsOf(graph)}
          allowNone
        />
      </Box>

      <NumberField
        label="Carry at most N messages"
        value={link.maxTraversals}
        min={0}
        allowEmpty
        placeholder="Unlimited"
        onChange={(next) => updateLink(link.id, { maxTraversals: next })}
        helperText="A loop budget: once spent, the link closes. Empty = unlimited."
      />
    </>
  )
}

/* ------------------------------------------------------------------------------------------------ */
/* An agent, seen from the graph                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export function AgentGraphSettings({ agentId }: { agentId: string }): JSX.Element | null {
  const graph = useGraph()
  const topology = useStore((s) => s.spec.topology)
  const updateAgent = useStore((s) => s.updateAgent)

  const agent = graph.agents.find((a) => a.id === agentId)
  if (!agent) return null

  const dispatch = agent.dispatch ?? 'inherit'
  const outgoing = messageLinks(graph).filter((l) => l.source === agent.id)
  // The engine's own test, untrimmed: any non-empty label makes a link a branch.
  const labelled = outgoing.filter((l) => l.label)
  const unlabelled = outgoing.length - labelled.length
  const memories = nodesOf(graph)
    .filter((n): n is MemoryNode => n.kind === 'memory')
    .map((memory) => ({ memory, read: canRead(graph, agent.id, memory.id), write: canWrite(graph, agent.id, memory.id) }))
    .filter((m) => m.read || m.write)

  const branches =
    outgoing.length === 0
      ? 'No outgoing message link yet.'
      : labelled.length === 0
        ? `${outgoing.length} outgoing ${outgoing.length === 1 ? 'link' : 'links'}, none labelled.`
        : `Branches: ${labelled
            .map((l) => `${l.label} → ${nameOfNode(graph, l.target)}${l.isDefault ? ' (default)' : ''}`)
            .join(', ')}${unlabelled > 0 ? ` · ${unlabelled} unlabelled` : ''}.`

  return (
    <Stack spacing={2.25}>
      <Typography variant="caption" sx={{ opacity: 0.7, display: 'block' }}>
        IN THE GRAPH
      </Typography>

      <Box>
        <TextField
          select
          label="Dispatch"
          value={dispatch}
          // `inherit` is the absence of a choice, so it is stored as one.
          onChange={(e) => {
            const next = e.target.value as Dispatch
            updateAgent(agent.id, { dispatch: next === 'inherit' ? undefined : next })
          }}
          helperText="Which of its outgoing links carry its message"
          fullWidth
        >
          {DISPATCHES.map((d) => (
            <MenuItem key={d.value} value={d.value}>
              {d.value === 'inherit' ? `${d.label} (${topology})` : d.label}
            </MenuItem>
          ))}
        </TextField>
        <Caption sx={{ mt: 0.75 }}>{branches}</Caption>
        {/* What the runner does, said before the run: with no label there is nothing to name, and
            unlabelled links go out whatever the agent routes to. */}
        {dispatch === 'choose' && labelled.length === 0 && (
          <Caption tone="warning" sx={{ mt: 0.5 }}>
            None of its outgoing links has a label, so it has no branch to name and every link is taken. Select a link
            and give it a label.
          </Caption>
        )}
        {dispatch === 'choose' && labelled.length > 0 && unlabelled > 0 && (
          <Caption sx={{ mt: 0.5 }}>Unlabelled links are taken whatever it chooses.</Caption>
        )}
      </Box>

      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={agent.canSpawn === true}
              onChange={(e) => updateAgent(agent.id, { canSpawn: e.target.checked ? true : undefined })}
            />
          }
          label="May spawn helpers"
        />
        <Caption>It can create sub-agents or run a saved block for a subtask, within the swarm's depth and spawn limits.</Caption>
      </Box>

      <Box>
        <Label>Memories · {memories.length}</Label>
        {memories.length === 0 ? (
          <Caption>
            Not connected to any memory. Draw a link from this agent to a memory node to let it write, from the memory to
            the agent to let it read.
          </Caption>
        ) : (
          <Stack spacing={0.5}>
            {memories.map(({ memory, read, write }) => (
              <Box key={memory.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {memory.name}
                </Typography>
                <Chip size="small" variant="outlined" label={rights(read, write)} />
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}
