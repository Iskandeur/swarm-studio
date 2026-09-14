# Swarm Studio

**[Open the live app →](https://iskandeur.github.io/swarm-studio/)** (no key needed: a demo provider
ships with it)

A browser studio for building, running and **watching** multi-agent swarms.

Draw the agents. Say who is allowed to speak to whom. Pick a model and a system prompt per agent.
Press Run, and watch the conversation travel through the graph as it happens — nodes light up while
they think, messages slide along the links they are actually sent on, the transcript fills in live.

No backend, no build step to deploy, no account. A demo provider ships with the app, so the whole
thing is usable — and demoable — with no API key at all.

## Why it exists

Most agent frameworks make the topology invisible: it lives in code, and the only thing you see is
the final answer. The interesting part of a swarm is the *shape* — who hears whom, and in what
order. This app makes the shape the primary object, and the run a thing you can watch.

## What you can do

| | |
| --- | --- |
| **Build a topology** | Drag agents around; drag from a node's right dot to another node's left dot to grant "may speak to". Links are directed, so hierarchies, rings and meshes are all expressible. |
| **Configure each agent** | Provider, model (free text — a new model release needs no code change), system prompt, temperature, colour. |
| **Choose a propagation rule** | `Broadcast` — every outgoing link carries the message. `Round-robin` — one link per turn, rotating. `Manager` — the entry agent delegates, workers report back, the manager speaks again with every reply in hand. |
| **Pick the entry points** | Mark which agents receive the task. With none marked, every agent that has no incoming link starts the run. |
| **Watch it run** | Per-node status and a live tail of the text being produced, an animated packet on every link that carries a message, a colour-matched transcript, round and token counters. |
| **Export** | Download the swarm as JSON. |

## Providers

| Provider | Key needed | Notes |
| --- | --- | --- |
| **Demo** | no | Local canned answers, streamed with realistic timing. Everything works offline. |
| **Anthropic** | yes | Messages API, streamed straight from the browser. |
| **OpenAI** | yes | `/chat/completions`, streamed. |
| **OpenRouter** | yes | `/chat/completions`, streamed. |

Keys live in this browser's local storage and go straight to the provider — there is no server in
this project to pass them through. Browser-to-provider calls depend on the provider allowing
cross-origin requests; if one refuses, put your own proxy in front of it. Use a key with a spend
limit.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine rules + a jsdom mount test — no key, no network
npm run build
```

Node 22+.

### Publishing

Every push to `main` publishes to [GitHub Pages](https://iskandeur.github.io/swarm-studio/) via
`.github/workflows/pages.yml` (tests run first; a red suite does not publish). Any static host works
too — the build output is plain files, since there is no server side. If you fork this, switch
**Settings → Pages → Source** to *GitHub Actions* once, or the workflow stops at `configure-pages`.

## How the engine works

One round = every currently-active agent speaks, in parallel. Each message is then handed to the
agents its author may speak to, and those become the next round's active set. The run stops when
nobody is left to speak or `maxRounds` is reached. Every agent keeps its own conversation history,
so it remembers what it already said.

Everything the UI animates comes out of engine callbacks (`onAgentStatus`, `onMessageDelta`,
`onTransit`, …), so the visualisation never guesses: it draws exactly what the engine did.

```
src/
  types.ts              domain model
  store.ts              zustand store, localStorage persistence
  presets.ts            three starter swarms
  theme.ts              Material theme + per-agent colour derivation
  engine/
    providers.ts        one streaming adapter per provider
    runner.ts           rounds, propagation rules, callbacks
    runner.test.ts      pins the propagation rules
  components/           TopBar · Inspector · GraphCanvas · AgentNode · MessageEdge · TranscriptPanel · RunBar
```

## Stack

React 18 · TypeScript · Vite · MUI (Material Design 3 flavoured) · React Flow (`@xyflow/react`) ·
zustand. No backend, no database.

## Licence

MIT — see [LICENSE](LICENSE).
