# The interchange format

One promise: **paste this into someone else's Swarm Studio and they get your configuration.**

Everything needed to reproduce a run travels. Two things never do:

- **API keys** — yours, and a format meant to be pasted into a chat must not carry them.
- **Endpoint URLs** — private infrastructure. A gateway address is not part of a swarm's design, and
  it identifies a network.

Reader and writer live in [`src/engine/portable.ts`](../src/engine/portable.ts), with the test suite
next to it. `version` is `2`; version 1 exports still read, unchanged.

## A whole swarm

```json
{
  "format": "swarm-studio",
  "version": 2,
  "kind": "swarm",
  "name": "The Cat Council",
  "task": "The cat wants to go outside. It is raining. Decide.",
  "topology": "broadcast",
  "maxRounds": 3,
  "entryIds": ["cat"],
  "agents": [
    {
      "id": "cat",
      "name": "The Cat",
      "provider": "mock",
      "model": "demo-fast",
      "systemPrompt": "You issue demands, never arguments…",
      "temperature": 0.7,
      "hue": 32,
      "position": { "x": -40, "y": 0 }
    }
  ],
  "links": [{ "id": "l1", "source": "cat", "target": "human" }]
}
```

| Field | Meaning |
| --- | --- |
| `topology` | `broadcast`, `round-robin` or `manager` — which of the links a turn actually uses. |
| `maxRounds` | Hard stop on the number of turns. No upper bound; above 40 the app warns you. |
| `entryIds` | Agents that receive the task. Empty means "every agent with no incoming link". |
| `agents[].provider` | `mock`, `anthropic`, `openai`, `openrouter` or `custom`. |
| `agents[].model` | Free text: whatever model id the endpoint accepts. |
| `agents[].hue` | 0–360. Drives that agent's colour everywhere it appears. |
| `links[]` | Directed: `source` may speak to `target`. |

## A clipping of agents

The same shape without the swarm-level fields. Only links whose **both** ends are in the clipping
travel — a link to an agent the recipient does not have would reference nothing.

```json
{
  "format": "swarm-studio",
  "version": 2,
  "kind": "agents",
  "agents": [ … ],
  "links": [ … ]
}
```

## What the reader accepts

Deliberately forgiving on the way in, because this lands in a paste box:

- either `kind`, a bare array of agents, or a single agent object;
- an export from an earlier version with no `format` field at all;
- missing `position`, `hue` or `temperature` — they get sensible values;
- an unknown `provider` falls back to `mock`, which needs no key;
- an out-of-range `temperature` is clamped rather than passed through to a provider that would refuse it;
- links that are duplicated, self-looping, or pointing at an absent agent are dropped.

It is strict about two things. A `format` that is not `swarm-studio` is refused by name, and a
`version` newer than this build is refused with "update the app" rather than half-read. Every refusal
returns a sentence written for a human, because the only place it is ever shown is a paste box.

Ids that collide with agents already on the canvas are re-keyed on paste, and those agents are
offset, so pasting the same clipping twice does not stack two nodes invisibly.

## Version 2: nodes, conditional links, blocks

Everything above still holds. Version 2 adds four optional fields to a swarm and a few to agents and
links. A version-1 export is simply a version-2 swarm that uses none of them.

```json
{
  "format": "swarm-studio",
  "version": 2,
  "kind": "swarm",
  "maxDepth": 3,
  "maxSpawns": 12,
  "agents": [{ "id": "det", "name": "The Detective", "dispatch": "choose", "canSpawn": true, "…": "…" }],
  "nodes": [
    { "id": "ev", "kind": "memory", "name": "Evidence", "mode": "blackboard", "wakeReaders": false,
      "maxChars": 2400, "seed": [{ "key": "label", "value": "PROPERTY OF DENISE", "author": "seed", "round": 0, "version": 1 }],
      "position": { "x": 0, "y": 200 } },
    { "id": "q", "kind": "condition", "name": "Suspect?", "position": { "x": 300, "y": 0 },
      "predicate": { "op": "memory", "memory": "Evidence", "key": "suspect", "cmp": "exists" } },
    { "id": "b", "kind": "block", "name": "Second opinion", "blockId": "critic", "position": { "x": 500, "y": 0 } }
  ],
  "links": [
    { "id": "l1", "source": "det", "target": "q", "label": "accuse", "isDefault": true, "maxTraversals": 3,
      "guard": { "op": "contains", "value": "guilty" } },
    { "id": "a1", "source": "det", "target": "ev", "kind": "access", "access": "readwrite" }
  ],
  "blocks": [{ "id": "critic", "name": "Critic", "description": "A second look.", "graph": { "agents": [], "nodes": [], "links": [], "entryIds": [] } }]
}
```

| Field | Meaning |
| --- | --- |
| `maxDepth` | How deep blocks may nest and helpers may spawn helpers. Default 3, at most 8. |
| `maxSpawns` | Helpers agents may create in one run. Default 12, at most 100. |
| `agents[].dispatch` | `inherit` (the topology decides), `all`, `rotate`, or `choose` (the agent names a labelled link with `<route to="…"/>`). |
| `agents[].canSpawn` | May create helpers with `<spawn>`. |
| `nodes[].kind` | `condition`, `join`, `output`, `human`, `memory`, `block` or `decision`. |
| `links[].kind` | `message` (default) or `access`. An access link joins exactly one memory and one agent: agent → memory writes, memory → agent reads, `access: "readwrite"` both. |
| `links[].label` | A branch name. `true`/`false` out of a condition, `approved`/`rejected` out of a human gate, anything for a `choose` agent. |
| `links[].guard` | A predicate (below). The link carries a message only when it holds. |
| `links[].maxTraversals` | Loop budget: the link closes after carrying this many messages. |
| `blocks[]` | Block definitions used by `block` nodes, so a pasted swarm is self-sufficient. A clipping carries the definitions of the blocks it contains. |

### Predicates

A condition is data. The reader keeps only known operators and fields; nothing in it is ever
evaluated as code.

| `op` | Fields | True when |
| --- | --- | --- |
| `always` | | always |
| `contains` | `value`, `caseSensitive?` | the message contains `value` |
| `matches` | `pattern`, `flags?` (`i m s u`) | the message matches. Patterns over 200 characters, or that repeat a repetition like `(a+)+`, are refused: they can freeze a page. |
| `json` | `path`, `cmp`, `value?` | the first JSON object in the message has `path` (dotted, numbers index arrays) comparing true |
| `memory` | `memory`, `key`, `cmp`, `value?` | the named memory's current value for `key` compares true |
| `decision` | `path`, `cmp`, `value?` | the typed answer a Decision node attached to the message, at `path` (`route.choice`, `route.confidence`, `urgent.yes`), compares true. False, with a notice, when no Decision node answered upstream. |
| `visits` | `cmp`, `value` | this link (or condition node) has fired that many times before |
| `round` | `cmp`, `value` | the round number compares true |
| `all` / `any` | `of: [...]` | every / any child holds |
| `not` | `of: {...}` | the child does not hold |

`cmp` is one of `eq neq gt gte lt lte exists contains`. Numbers compare as numbers when both sides
are numeric; anything malformed evaluates to false and says why.

Also dropped on the way in, in version 2: an access link that does not join one memory and one
agent, a message link that touches a memory, a node whose id is already an agent's, a block node
without a `blockId`, a node of unknown kind.

### Decision nodes

A `decision` node asks a decision model (a "System One" model: TypeSafe's Jev is the first) typed
questions about what reaches it. It writes no text. It forwards the message it judged, with its
answers attached, and the guards on its outgoing links read them with the `decision` predicate.

```json
{
  "id": "triage", "kind": "decision", "name": "Triage", "position": { "x": 0, "y": 140 },
  "provider": "openrouter", "model": "typesafe/jev-1.13",
  "questions": [
    { "name": "route", "type": "choice", "instructions": "Which desk should answer?",
      "options": [{ "label": "billing", "criterion": "payments, invoices, refunds" },
                  { "label": "technical", "criterion": "bugs, crashes, errors" }] },
    { "name": "blocked", "type": "noul", "instructions": "Is the customer unable to use the product?",
      "options": [{ "label": "true", "criterion": "the app crashes or access is lost" }] },
    { "name": "anger", "type": "score", "instructions": "How upset is the customer?",
      "levels": ["calm", "annoyed", "furious"] }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `provider` | `mock` (the demo decider, no key), `openrouter` (OpenRouter's `/api/alpha/decisions`, with the OpenRouter key) or `typesafe` (TypeSafe's own `/v1/systemone`, with a TypeSafe key). |
| `model` | Free text. `typesafe/jev-1.13` on OpenRouter, `jev-latest` on TypeSafe. |
| `questions[].name` | One word; the key its answer comes back under, and the first segment of a guard path. |
| `questions[].type` | `choice`: pick one of `options` (≥ 2). `noul`: yes or no; `options` may describe `true` and `false`. `score`: a level on `levels` (≥ 2, lowest first). |

What a guard can read, per type:

| Type | Answer fields |
| --- | --- |
| `choice` | `choice` (a label), `confidence` (0–1), `probabilities.<label>` |
| `noul` | `noul` (probability of yes, 0–1), `yes` (`noul` ≥ 0.5) |
| `score` | `score` (the expected level, may be fractional), `level` (its name), `confidence`, `probabilities.<n>` |

A link out of a decision with `"isDefault": true` is the else branch: it is taken only when no other
link of that node is. That is the System 1 → System 2 pattern in one link: route when the decision
model is sure, escalate to an LLM agent when it is not (see the *Triage* preset).

The reader also accepts the API's own question shape, so a request copied from TypeSafe's docs pastes
as is: `questions` as an object keyed by name, with `criteria` as `{label: description}` (choice,
noul) or a list of levels (score).

