# Graph engineering in Swarm Studio

Design for the second generation of the engine: conditional control flow, reusable and recursive
blocks, agents that spawn agents, and shared memory between agents. Written before the code, so the
code has something to be checked against.

## Where we start

The engine is already a **superstep machine**. One round = every active node runs in parallel, then
its output is delivered along links, and whoever received something is active next round. That is
the Pregel model, which is also what LangGraph runs underneath. So nothing here replaces the loop in
`runner.ts`: it widens *what a node can be*, *what a link can require*, and *what agents can share*.

What the current engine cannot express, and what this design adds:

| Missing today | SOTA name | What we add |
| --- | --- | --- |
| Every link always fires | conditional edges | a **guard** on each link, and deterministic **Condition** nodes |
| Only the global topology decides who hears what | `Command(goto)`, handoffs | per-agent **dispatch**, including `choose`: the agent picks the branch |
| A loop runs until `maxRounds` | recursion limits, loop budgets | `maxTraversals` per link, a `visits` predicate |
| Fan-in is "whatever arrives this round" | barriers / joins | a **Join** node that waits for every branch |
| No explicit result | graph output / END | an **Output** node |
| The human can only pause and inject | `interrupt()` | a **Human gate** node that stops the flow until approved |
| Copy-paste is the only reuse | subgraphs | **Blocks**: a saved graph used as one node, recursively |
| The graph is fixed before the run | `Send` / orchestrator-workers / agents-as-tools | **Spawn**: an agent creates sub-agents live on the canvas |
| Agents only pass messages | blackboard, pub/sub, shared state channels | **Memory** nodes: blackboard, log/bus, shared document, seeded knowledge |

## 1. Data model

`Agent` stays as it is, and stays in `spec.agents`: most of the UI and most of the tests are built
around it. Everything else is a new, discriminated `FlowNode` in `spec.nodes`. A lookup by id checks
both. `SwarmSpec` becomes a `Graph` plus run settings, so a Block can hold a graph of the same type.

```ts
export interface Graph {
  agents: Agent[]
  nodes: FlowNode[]          // new, defaults to []
  links: Link[]
  entryIds: string[]
}

export interface SwarmSpec extends Graph {
  name: string
  task: string
  topology: Topology         // now the DEFAULT dispatch for agents that say `inherit`
  maxRounds: number          // global step budget (LangGraph's recursion_limit)
  maxDepth?: number          // nesting limit for blocks and spawns, default 3
  maxSpawns?: number         // per run, all depths together, default 12
  blocks?: BlockDef[]        // block definitions travel WITH the swarm that uses them
}

export interface Agent {     // existing fields unchanged, plus:
  dispatch?: 'inherit' | 'all' | 'rotate' | 'choose'
  canSpawn?: boolean
}

export interface Link {
  id: string
  source: string
  target: string
  kind?: 'message' | 'access'     // absent = message
  label?: string                  // branch name, shown on the edge, used by `choose`
  guard?: Predicate               // absent = always
  isDefault?: boolean             // taken when a `choose` names nothing valid
  maxTraversals?: number          // loop budget on this edge
  access?: 'read' | 'write' | 'readwrite'  // for kind: 'access' only
}

export type FlowNode = ConditionNode | JoinNode | OutputNode | HumanNode | MemoryNode | BlockNode
interface NodeBase { id: string; name: string; position: { x: number; y: number } }

export interface ConditionNode extends NodeBase { kind: 'condition'; predicate: Predicate }
// outgoing links labelled "true" / "false"; the Inspector creates both handles.

export interface JoinNode extends NodeBase { kind: 'join'; mode: 'all' | 'any'; timeoutRounds?: number }
export interface OutputNode extends NodeBase { kind: 'output' }
export interface HumanNode extends NodeBase { kind: 'human'; prompt: string }
// outgoing links labelled "approved" / "rejected".

export interface MemoryNode extends NodeBase {
  kind: 'memory'
  mode: 'blackboard' | 'log' | 'document'
  wakeReaders: boolean            // true = a bus: a write activates every reader next round
  seed: MemoryEntry[]             // a knowledge base you load before the run
  maxChars: number                // what one reader receives per turn, default 2400
}
export interface MemoryEntry { key: string; value: string; author: string; round: number; version: number }

export interface BlockNode extends NodeBase {
  kind: 'block'
  blockId: string
  overrides?: { provider?: ProviderId; model?: string }   // applied to every agent inside
}

export interface BlockDef {
  id: string
  name: string
  description: string            // shown in the library, and to agents that may spawn it
  graph: Graph
}
```

**Migration.** A stored or pasted v1 spec has no `nodes`, no `kind`, no `blocks`: it is a valid v2
spec once `nodes: []` is filled in. One `migrateSpec()` does it, called by the store on load and by
`parsePortable`. The portable format goes to `version: 2`; the reader keeps accepting 1.

## 2. Predicates — conditions without code

A pasted swarm comes from someone else. So **a condition is data, never code**: no `eval`, no
`new Function`. A small declarative language, evaluated by one pure function
`evaluate(predicate, context)` in `src/engine/predicates.ts`.

```ts
export type Predicate =
  | { op: 'always' }
  | { op: 'contains'; value: string; caseSensitive?: boolean }
  | { op: 'matches'; pattern: string; flags?: string }        // RegExp, pattern ≤ 200 chars
  | { op: 'json'; path: string; cmp: Cmp; value?: string | number | boolean }
  | { op: 'memory'; memory: string; key: string; cmp: Cmp; value?: string | number | boolean }
  | { op: 'decision'; path: string; cmp: Cmp; value?: string | number | boolean }  // §3.9
  | { op: 'visits'; cmp: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value: number }
  | { op: 'round'; cmp: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value: number }
  | { op: 'all' | 'any'; of: Predicate[] }
  | { op: 'not'; of: Predicate }
type Cmp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'contains'
```

- **Subject** is the text of the message crossing the link or entering the node.
- `json` reads the first JSON object found in the message (a fenced block or a bare `{…}`), then a
  dotted `path` (`verdict.score`). No JSON, or no such path: the comparison is false, never a throw.
- `memory` reads a key of a Memory node by name, so a route can depend on shared state
  (`status == "approved"`) and not only on the last message.
- `decision` reads the typed answers a Decision node attached to the message (`route.choice`,
  `route.confidence`, `urgent.yes`): routing on a decision model's verdict and on how sure it was.
- `visits` counts how many times the link (on a guard) or the node (on a Condition) has fired in this
  run. It is how a critic loop says "at most three drafts" in the graph instead of in a prompt.
- A bad regex, a bad path, an unknown `op`: evaluates to `false` and reports one notice. A condition
  that throws would kill a run for a typo.
- Regex input is capped at 20 000 characters: a pasted pattern must not freeze the tab.

## 3. Execution semantics

The round loop stays. What changes is what happens between "agents spoke" and "next round".

### 3.1 Agents: dispatch

After an agent's turn, its outgoing **message** links are filtered in this order:

1. **Dispatch.** `all` keeps every link. `rotate` keeps one, rotating (today's round-robin). `choose`
   keeps the links whose `label` the agent named with `<route to="label"/>` (several labels allowed,
   comma-separated). If it named none that exists: the `isDefault` link if there is one, otherwise
   nothing, and a notice says so. `inherit` uses the swarm's `topology`. `manager` stays a global
   topology with its current behaviour.
2. **Guards.** Each kept link's `guard` is evaluated against the message. False = not taken.
3. **Budget.** A link whose `maxTraversals` is spent is not taken; a notice says it the first time.

An agent with `choose` is told its branches in the system prompt: label, and target name.

### 3.2 Deterministic nodes run inside the same round

Condition, Join, Output and Memory nodes cost no tokens and no time. If they took a round each, a
condition would add a visible pause and burn the step budget. So after the agents of a round have
spoken, deliveries are **resolved transitively** through deterministic nodes until every message
rests at an agent, a Block, a Human gate, or nowhere:

- **Condition** evaluates its predicate and forwards the message to its `true` or `false` links.
- **Join (`all`)** holds what arrives and forwards one combined message — each part labelled with its
  author — once every *activated* incoming branch has delivered. A branch counts as activated when
  its source ran in this run. `timeoutRounds` releases whatever it holds after N rounds, with a
  notice. **Join (`any`)** forwards the first arrival and drops the rest of that wave.
- **Output** records the message as a result of this graph (`onOutput`). It never forwards.
- A cycle made only of deterministic nodes would never end: resolution stops after 64 hops and the
  run fails with a message naming the nodes.

### 3.3 Human gate

A message reaching a Human node pauses the run (the existing session pause) and raises
`onHumanGate({ nodeId, text })`. The UI shows the text, editable, with Approve and Reject. Approve
sends the (possibly edited) text on the `approved` links, Reject on `rejected`. Stop still works.

### 3.4 Memory — how agents share knowledge

Access links connect an agent to a Memory node. The direction on the canvas follows the data:
`agent → memory` is write, `memory → agent` is read, and `readwrite` is drawn as one link with two
arrowheads. An agent without access to a memory neither sees it nor can write it.

**Reading.** Each turn, a reader gets the memory rendered into its system prompt, under its own
heading, capped at `maxChars`:

- `blackboard`: current value per key, most recently updated first;
- `log`: newest entries first, `author (round): value`;
- `document`: the current text, then `version N, last edited by X`.

When the rendering does not fit, entries are ranked by term overlap with the messages the agent is
about to answer (plain token overlap, no embeddings), and the rest is summarised as
`… 14 more entries not shown`. This is the retrieval step of a knowledge base, done without a
vector store.

**Writing.** A writer is told the syntax in its system prompt, and only the syntax its memories
accept:

```
<write memory="Evidence" key="suspect">The toaster</write>      blackboard: set key
<write memory="Newsroom">Breaking: the toaster denies it</write>  log: append
<write memory="Draft">…full new text…</write>                    document: replace, version+1
```

Writes are applied at the end of the turn in transcript order, each one stamped with author and
round, and raise `onMemoryWrite`. A write to a memory the agent may not write is dropped with a
notice — the permission is the graph's, not the prompt's.

**Bus.** With `wakeReaders`, a write activates every reader next round with a
`[memory Newsroom] X wrote: …` message. That turns the node into a pub/sub topic: agents that are
not linked by messages at all can still react to each other.

**Seed.** Entries typed or pasted in before the run: reference documents, a glossary, the rules of
the game. A read-only seeded memory is a knowledge base in the literal sense.

**Scope.** A memory belongs to the graph it is drawn in. A memory inside a Block is private to each
run of that block; the parent's memories are not visible inside. (A later `shared` scope can lift
that; not in this pass.)

This gives five ways for agents to communicate, each a different coupling:

| Pattern | How | Coupling |
| --- | --- | --- |
| Direct message | message link | point to point, synchronous |
| Blackboard | memory `blackboard`, agents read and write keys | shared state, no addressee |
| Bus / topic | memory `log` with `wakeReaders` | publish-subscribe |
| Co-written document | memory `document` | one artefact, versioned |
| Knowledge base | memory with `seed`, read-only links | reference material, retrieved per turn |

### 3.5 Blocks — reuse, and recursion

A Block is a graph saved under a name. Dropped on the canvas it is **one node**; double-clicking it
opens its inside (breadcrumb at the top of the canvas to go back up). Editing the inside edits the
definition, so every instance changes — like a component. "Detach" replaces an instance with an
inline copy of its graph.

**Running a block node** starts a nested run of its graph (`runGraph`, the extracted core of
`runSwarm`) with:

- as task, the messages it received this round;
- `depth + 1`; at `depth === maxDepth` the block does not run and its output is the notice
  `depth limit reached`, so recursion bottoms out instead of failing;
- its own session (memory, cursors), and the parent's step budget still counting: nested rounds are
  charged to the same `maxRounds` so a recursive block cannot run for ever;
- callbacks wrapped with a `path` (`['blockNodeId', …]`), so transcript entries and statuses know
  where they happened.

The **result** of the nested run is what reached its Output nodes, or when it has none, the last
message of each leaf agent. That result leaves the block node on its outgoing links like an agent's
message. While the nested run goes, the parent round waits for it — it is one node's turn.

**Recursion** is then just a block whose graph contains a block node pointing at its own `blockId`.
What makes it useful rather than infinite is a Condition or a `choose` in front of the self-reference:
"is this small enough to answer directly?" — the recursive decomposition pattern (divide, recurse,
merge).

**Library.** Three sources, one list: blocks embedded in the current swarm (`spec.blocks`), blocks
saved in this browser (`localStorage`), and built-ins shipped with the app. "Save selection as block"
turns selected agents and nodes, with the links between them, into a definition. Built-ins to ship:

- **Critic loop** — Writer ⇄ Critic, a condition on the critic's JSON verdict, at most 3 drafts.
- **Debate** — Pro and Con in parallel, a Join, a Judge.
- **Map-reduce** — a Splitter that spawns one worker per part, a Join, a Reducer.
- **Recursive solver** — decides "direct or split", recurses on each part, merges.

### 3.6 Spawn — agents that create agents

An agent with `canSpawn` is told it may delegate, and how:

```
<spawn name="Forensic Accountant">You audit the snack budget. Find the missing 12 €.</spawn>
<spawn block="Critic loop">Write the apology note to the office.</spawn>
```

At the end of its turn, each spawn creates an **ephemeral** node for the rest of the run: a raw agent
(provider, model and temperature inherited from the parent, the tag's body as its task, and a short
role derived from `name`) or an instance of the named block. It is drawn next to its parent, with a
dashed link, and it runs next round. Its answer comes back up to the parent, like a manager-mode
reply. A spawned agent with `canSpawn` inherited can spawn again: that is live recursion, bounded by
`maxDepth` and by `maxSpawns` for the whole run. A spawn past either limit is refused and the parent
receives `[system] spawn refused: limit reached` next round, so it can answer by itself.

Ephemeral nodes live in the run state, never in `spec`: a reset clears them. After a run, **Keep
spawned agents** copies them into the swarm as ordinary agents, so a structure the model invented
can be kept and edited.

### 3.7 Actions are tags, for now

`<route/>`, `<write/>` and `<spawn/>` are parsed from the answer text, by one parser
(`src/engine/actions.ts`), at the end of the turn. The transcript shows them as chips and the
remaining prose as the message; the message forwarded on links is the prose only.

Why tags rather than native tool calls: they behave the same on the five providers, on the demo
provider, and on OpenAI-compatible gateways whose tool-call support is partial; they stream, so the
viewer sees the decision being written. The cost is that a model can malform a tag. The parser is
lenient on quotes and whitespace, ignores anything it cannot read, and reports it as a notice.
Native tool calls become the better choice once there is a backend and real tools to call (see §6).

### 3.8 Callbacks added

```ts
onOutput?:      (e: { path: string[]; nodeId: string; text: string }) => void
onMemoryWrite?: (e: { path: string[]; memoryId: string; entry: MemoryEntry }) => void
onMemoryRead?:  (e: { path: string[]; memoryId: string; agentId: string }) => void
onSpawn?:       (e: { path: string[]; parentId: string; node: Agent | BlockNode; link: Link }) => void
onHumanGate?:   (e: { path: string[]; nodeId: string; text: string }) => void
onBranch?:      (e: { path: string[]; nodeId: string; taken: string[]; skipped: string[] }) => void
```

Every existing callback gains an optional `path` (absent = top level). The rule of the current
engine holds: **the UI draws exactly what the engine reported**, never a guess.

### 3.9 Decision nodes — System 1 → System 2

Added in the ninth pass. Some models do not write text at all. TypeSafe's **Jev**, the first of what
TypeSafe calls *System One* models, answers typed questions about a `state`: a `choice` among
labels, a `noul` (the probability of yes), a `score` on an ordered rubric. Each answer comes back
with probabilities and a confidence, in one cheap call. That is exactly what a router needs, and
exactly what an LLM is bad at being: an LLM asked for a label writes one, with no honest idea of how
sure it is.

A **Decision** node (`kind: "decision"`, [`src/engine/decisions.ts`](../src/engine/decisions.ts)) is
that call, placed in the graph:

- **It takes a turn, like an agent or a block.** It costs a request and some latency, so it is
  scheduled in the round rather than resolved inline like a Condition (`TURN_KINDS` in `graph.ts`).
  It can receive the task (it is often the entry point).
- **State in, answers out.** Whatever reached it is the `state`. Its questions are configured in the
  inspector (name, type, instructions, labels with criteria or levels) and sent all at once.
- **It generates no text.** The transcript shows its answers (and a `decision` chip); the canvas
  node shows the chosen answer and a probability bar per option. What it forwards is the message it
  judged, followed by one line of verdict, so the agent it escalates to reads both.
- **Answers travel with the message.** They ride on the delivery, through zero-token nodes too, so a
  guard on its outgoing links — or on a Condition two hops down — reads them with the `decision`
  predicate. The next agent's turn is a new message and carries none.
- **Routing.** A Decision node sends its message along every outgoing link whose guard holds. A link
  marked `isDefault` is the else branch, taken only when no other link is. The *Triage* preset is
  the whole pattern: three desks, each behind `route.choice = X and route.confidence ≥ 0.6`, and a
  default link to a senior LLM agent. When the decision model is sure, a specialist answers; when it
  hesitates, the expensive model reads the whole thing. System 1, then System 2 only when needed.
- **Strict parsing.** An answer without a usable choice (absent, not one of the labels, no
  confidence) fails the run with a sentence naming the question. It is never replaced by a default:
  a silent 0.5 would route a message as if the model had been unsure when it had said nothing.
- **Providers.** `openrouter` calls `https://openrouter.ai/api/alpha/decisions` with the OpenRouter
  key already entered for chat (its CORS policy allows any origin: checked with a preflight from the
  Pages origin, and with a real call). `typesafe` calls TypeSafe's own `/v1/systemone` with a
  TypeSafe key, same request shape — but that API refuses browser origins, so from the published
  site it needs a relay of your own in its endpoint field, like any gateway that does not allow the
  page. `laya` calls an open-weight model on your own machine (`http://127.0.0.1:8000/v1/systemone`
  by default), with no key unless the server was started with one; `laya-serve` sends no CORS
  headers, so `tools/laya-serve-cors.py` runs it with them (checked in Chromium from the Pages
  origin: plain `laya-serve` fails, the script goes through). `mock` is the demo decider: it weighs each option by the words it shares with the message,
  deterministic and labelled demo, so the preset runs with no key. The model field is free text, so a
  new decision model is a new string, not new code.
- **Callback.** `onDecision({ path, nodeId, answers })`, which the store keeps per node for the bars.

### 3.10 Prompting the graph

The graph is JSON in a documented format, which is exactly what a model writes well. **Prompt the
graph** (a button in the top bar, on every layout) turns a description into a swarm, or applies a
described change to the current one. [`src/engine/graphPrompt.ts`](../src/engine/graphPrompt.ts):

1. **The model gets the real format.** The system prompt is built from the same lists the reader
   checks against (providers, node kinds, predicate ops, question types): a compile-time check fails
   when a node kind or a predicate op exists in `types.ts` but not in the generator's list. Two
   presets, serialised by the exporter itself, are the examples.
2. **The answer goes through the existing reader**, then through an audit of what the reader had to
   drop. The reader is right to be forgiving with a paste; a generated graph that silently lost a
   guard is a different graph (an unguarded link). So a dropped node, link, guard, predicate or
   question is an error.
3. **One repair.** The first error goes back to the model with its answer, once. After that a
   person reads the error, and the canvas has not been touched.
4. **Edit keeps ids by construction.** A model that re-keyed an existing node (same kind, same name,
   new id) gets its id put back everywhere; a position it left out is restored. A node it removed is
   gone, which is what "remove the critic" means.
5. **One undo step.** Loading is `replaceSwarm`, which pushes the previous swarm on the history.
6. **Nothing secret goes in or comes out.** The current graph is sent through the exporter, which has
   no field for keys or endpoints; the answer is also checked against the keys and endpoint URLs this
   browser holds.

With no key, a **demo generator** picks the preset whose theme matches the words (or makes one fixed
kind of edit), streams it like a real answer, and says it is a demo.

## 4. Interface

- **Node palette** (a pill at the top-left of the canvas, on every layout): Agent, Decision,
  Condition, Join, Output, Human gate, Memory, Block (opens the library).
- **Prompt the graph** (§3.10): the first screen is the prompt card, over the canvas; once a graph
  is loaded it folds into the command bar under the canvas (a strip above the navigation on a
  phone). `Ctrl/⌘ + K`, the expand button on the bar, or the ⋮ menu bring the card back.
- **Layout**: the side panels — Build (roster + inspector) on the left, Transcript on the right —
  are closed until asked; clicking a node opens Build, starting a run opens Transcript. Run, the
  task and the topology settings live at the right of the command bar.
- **Shapes.** Agent: the current card. Condition: a diamond with `true`/`false` handles. Join: a
  narrow bar. Output: a flag. Human gate: a hand. Memory: a cylinder showing its entry count, which
  flashes in the writer's colour on each write. Block: a stacked card with a mini progress line
  (inner round, inner agents as dots) while it runs. Decision: a card with a coloured edge listing its
  questions, and after a call the chosen answer with a probability bar per option. Ephemeral nodes:
  dashed outline, fade in.
- **Edges.** Labels are visible. A guarded edge shows a small filter icon; hovering it shows the
  predicate in words (`if message contains "guilty"`). Access links are dashed and never animate a
  message packet; a read pulses toward the agent, a write toward the memory. After a branch
  decision, skipped edges dim for the rest of the round.
- **Inspector** per node kind. The predicate editor is a form (operator, field, value, and nested
  groups for all/any/not), never a code box. A preview line says the predicate in English.
- **Memory panel** in the transcript area: tabs per memory, entries with author colour, round,
  version; a document shows its current text and a version slider.
- **Transcript**: entries from nested runs are indented under their block with a breadcrumb; action
  chips (`→ Evidence.suspect`, `spawned Forensic Accountant`, `route: guilty`).
- **Library dialog**: search, three sections (this swarm, saved here, built-in), insert, save
  selection as block, delete a saved block.

## 5. Delivery order and acceptance

Each phase ends with `npm test` green, `npm run build` green, one commit on `graph-engineering`.

1. **Model.** `types.ts` v2, `migrateSpec`, portable v2 reading v1, `predicates.ts`, `actions.ts`.
   Tests: every predicate op including malformed input; tags parsed leniently; a v1 export read
   intact; a v2 round trip loses nothing; no `eval`/`Function` anywhere in `src/engine`, no import of
   React/MUI/the store, no unguarded `window` (a test greps for all three).
2. **Control flow.** `runGraph` extracted; dispatch `choose`; guards; `maxTraversals`; Condition,
   Join, Output, Human gate; deterministic resolution and its cycle guard. Tests: each semantic in
   §3.1–3.3 on the mock provider, and **the three existing presets produce the same transcript
   shape as before** (who spoke, to whom, how many rounds).
3. **Memory.** Read rendering with the cap and the overlap ranking, write permissions, the three
   modes, bus wake-up, seed. Tests for each, including a write refused for lack of access.
4. **Blocks and spawn.** Nested runs, result collection, depth limit, shared step budget, self-
   recursion that terminates, spawn of an agent and of a block, `maxSpawns`, refusal message, Keep
   spawned agents. Tests for each, including a recursive block with no condition, which must stop at
   `maxDepth` and not before.
5. **Interface.** §4, with mount tests for each node kind, the predicate editor, the memory panel and
   the library.
6. **Demos.** The demo provider learns to emit the tags, so every new mechanism runs without a key.
   Two new presets alongside the existing three, in the same humour: one showing conditions, a
   join, a human gate and a blackboard; one showing spawn and a recursive block. `docs/format.md`
   updated to v2. Deployed, and checked on the live page by bundle fingerprint.

## 6. What stays out, and the road to running code

Out of this pass: checkpoints and time travel (rewind to round N, fork), native tool calls, a
`shared` memory scope across block levels, embeddings.

Running code does not by itself force leaving the browser: Python runs in a Web Worker through
Pyodide, JavaScript in a sandboxed Worker. What the browser really cannot give is a run that survives
closing the tab, secrets that are not in `localStorage`, arbitrary HTTP without CORS, heavy compute,
and runs shared between people. That is the reason a server will be needed, not code execution alone.

The design keeps that move cheap: `src/engine` imports nothing from React, MUI or the store, and its
one browser reference (`window.location.origin` for the OpenRouter referer header, in
`providers.ts`) is guarded in phase 1 so it also runs where there is no `window`. A test keeps both
at zero. The same engine can then run in Node
behind an API, with the browser as a client, instead of being rewritten.
