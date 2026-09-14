# The interchange format

One promise: **paste this into someone else's Swarm Studio and they get your configuration.**

Everything needed to reproduce a run travels. Two things never do:

- **API keys** — yours, and a format meant to be pasted into a chat must not carry them.
- **Endpoint URLs** — private infrastructure. A gateway address is not part of a swarm's design, and
  it identifies a network.

Reader and writer live in [`src/engine/portable.ts`](../src/engine/portable.ts), with the test suite
next to it. `version` is `1`.

## A whole swarm

```json
{
  "format": "swarm-studio",
  "version": 1,
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
  "version": 1,
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
