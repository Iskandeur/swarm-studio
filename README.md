# Swarm Studio

**[Open the live app →](https://iskandeur.github.io/swarm-studio/)** (no key needed: a demo provider
ships with it)

A browser studio for building, running and **watching** multi-agent swarms.

Draw the agents. Say who is allowed to speak to whom. Pick a model and a system prompt per agent.
Press Run, and watch the conversation travel through the graph as it happens — nodes light up while
they think, messages slide along the links they are actually sent on, the transcript fills in live.

It is also a graph-engineering workbench: conditional branches, joins, human approval gates, shared
memory between agents, reusable blocks that can contain themselves, agents that spawn other agents
live on the canvas, and typed **decision models** (TypeSafe's Jev) that route in one cheap call and
escalate to an LLM only when unsure.

Or skip the clicking: **describe the swarm you want**, and a model writes the graph.

No backend, no build step to deploy, no account. A demo provider ships with the app, so the whole
thing is usable — and demoable — with no API key at all.

## Why it exists

Most agent frameworks make the topology invisible: it lives in code, and the only thing you see is
the final answer. The interesting part of a swarm is the *shape* — who hears whom, and in what
order. This app makes the shape the primary object, and the run a thing you can watch.

## What you can do

| | |
| --- | --- |
| **Prompt the graph** | Describe the swarm in a sentence (*"a support triage where anything unsure escalates to a senior agent"*) and a model writes it, streamed, in the same JSON format as Share. It goes through the same reader, plus an audit of anything the reader would have dropped, gets one automatic repair if it does not load, and lands as a single undo step — or nothing lands and the error says why. **Edit current** sends the swarm with the change to make and keeps every id. Uses the provider and model you already configured; with no key, a demo generator picks a matching preset and says so. |
| **Route with a decision model** | A **Decision** node asks a typed decision model — TypeSafe's **Jev** and the models like it — `choice`, yes/no and `score` questions about what reached it. No text is generated: it forwards the message with typed answers (choice, probabilities, confidence) that link conditions route on (`route.choice = billing`, `route.confidence < 0.6`). A *default* link catches everything else, which is the System 1 → System 2 pattern: cheap routing when sure, an LLM when not. The node shows its answer and a probability bar per option. Through OpenRouter's decisions endpoint with your OpenRouter key, or TypeSafe's API through a relay; a demo decider runs it with no key. |
| **Build a topology** | Drag agents around; drag from a node's right dot to another node's left dot to grant "may speak to". Links are directed, so hierarchies, rings and meshes are all expressible. |
| **Configure each agent** | Provider, model (free text — a new model release needs no code change), system prompt, temperature, colour. |
| **Choose a propagation rule** | `Broadcast` — every outgoing link carries the message. `Round-robin` — one link per turn, rotating. `Manager` — the entry agent delegates, workers report back, the manager speaks again with every reply in hand. |
| **Branch on conditions** | A link can carry a condition (message contains, matches a pattern, a JSON field compares, a shared-memory key has a value, a decision model's answer compares, this link has fired fewer than N times). Zero-token **Condition** nodes send to their `true` or `false` side, a **Join** waits for every branch, an **Output** marks the result. An agent set to *choose* names its branch itself with `<route to="…"/>`. Conditions are data, never code: a pasted swarm cannot run anything. |
| **Put a human in the loop** | A **Human gate** stops the flow and asks you. Approve, reject, or edit the text before it goes on. |
| **Share knowledge between agents** | A **Memory** node is a blackboard (shared keys), a log, or a co-written document. Draw agent → memory to let it write (`<write memory="…">`), memory → agent to let it read. A reader sees the memory in its prompt within a character budget, ranked by relevance when it does not fit; seed it with reference text and it is a knowledge base. Turn on *wake readers* and it becomes a publish-subscribe bus. |
| **Reuse and recurse** | Save any selection as a **Block**, drop it anywhere as one node, double-click to edit its inside (every instance follows). A block may contain itself: nested runs share the swarm's round budget and stop at the depth limit. Four built-ins: Critic loop, Debate, Map-reduce, Recursive solver. |
| **Let agents grow the graph** | An agent allowed to spawn writes `<spawn name="…">subtask</spawn>` (or `block="…"`), and the helper appears on the canvas, works, and answers its creator. Bounded by a depth limit and a spawn budget; keep what the model invented with one click. |
| **Pick the entry points** | Mark which agents receive the task. With none marked, every agent that has no incoming link starts the run. |
| **Watch it run** | Per-node status and a live tail of the text being produced, an animated packet on every link that carries a message, a colour-matched transcript, round and token counters. |
| **Share a configuration** | Copy the whole swarm, or just the agents you ticked, as JSON. Paste it into someone else's Swarm Studio and they get your setup — `Ctrl/⌘ + C`, `X` and `V` work on the canvas too, so cutting an agent puts it on the clipboard on its way out. API keys and endpoint URLs deliberately never travel. Format: [`docs/format.md`](docs/format.md). |
| **Export** | Download the swarm as JSON, in the same documented shape. |
| **Use it on a phone** | Below 900px the graph keeps the whole screen and the three panels become bottom sheets, with Run always one tap away. Pinch to zoom, drag to pan, and the connect dots grow on touch pointers. |

## Providers

| Provider | Key needed | Notes |
| --- | --- | --- |
| **Demo** | no | Local canned answers, streamed with realistic timing, and written *in character* for the agents the presets ship with — so pressing Run with no key shows four visibly different voices instead of four paragraphs of filler. Every demo message is badged `demo` in the transcript. |
| **Anthropic** | yes | Messages API, streamed straight from the browser. |
| **OpenAI** | yes | `/chat/completions`, streamed. |
| **OpenRouter** | yes | `/chat/completions`, streamed. |
| **Custom** | usually | Any endpoint that speaks OpenAI's `/chat/completions`: vLLM, Ollama, LM Studio, LiteLLM, a company gateway. You supply the URL. |

Decision nodes have their own providers, in the same dialog:

| Decision provider | Key | Notes |
| --- | --- | --- |
| **Demo decider** | no | Weighs each option by the words it shares with the message. Deterministic, badged `demo`. |
| **OpenRouter decisions** | the OpenRouter key | `/api/alpha/decisions`, model `typesafe/jev-1.13`. Callable straight from the browser. |
| **TypeSafe** | a TypeSafe key | `/v1/systemone`, same request. TypeSafe's API refuses browser origins, so from the published site it needs a relay of yours in its Endpoint URL field. |

**Every** provider's endpoint URL is overridable in Providers, so routing an agent through a mirror,
a gateway or a proxy never needs a code change. *Test and list models* calls the endpoint's `/models`
and fills the model dropdown, which doubles as a "is my URL and key actually working?" check.

Keys and URLs live in this browser's local storage and go straight to the endpoint — there is no
server in this project to pass them through. Use a key with a spend limit.

⚠️ **CORS decides what a browser-only app can reach.** The call only works if the endpoint returns
`Access-Control-Allow-Origin` for your origin. Internal gateways commonly allow `localhost` and
nothing else, in which case use `npm run dev` locally rather than the published site, or point the
Endpoint URL at a proxy of your own. A *Test* that fails with no detail at all is nearly always
this — the browser refuses the response before any status code reaches the page.

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

That is a superstep machine, the model LangGraph also runs on. Version 2 widens it rather than
replacing it: zero-token nodes act inside the round they are reached in, guards and loop budgets
filter links, blocks run as nested graphs charged to the same step budget, and actions (`<route/>`,
`<write/>`, `<spawn/>`) are tags parsed from the answer — the same on every provider, the demo one
included. The design, with the reasons: [`docs/graph-engineering.md`](docs/graph-engineering.md).

The engine imports nothing from the interface and touches no page global (a test keeps it that way),
so it can run in Node behind an API the day agents need to run code or outlive a browser tab.

Everything the UI animates comes out of engine callbacks (`onAgentStatus`, `onMessageDelta`,
`onTransit`, …), so the visualisation never guesses: it draws exactly what the engine did.

```
src/
  types.ts              domain model
  store.ts              zustand store, localStorage persistence
  presets.ts            seven starter swarms
  blocks.ts             built-in blocks
  theme.ts              Material theme + per-agent colour derivation
  engine/
    providers.ts        one streaming adapter per provider, and the demo voices
    runner.ts           rounds, dispatch, zero-token nodes, gates, blocks, spawn, callbacks
    predicates.ts       the condition language (data, never code)
    actions.ts          <route/> <write/> <spawn/> parsing
    memory.ts           shared memory: writes, and what a reader sees
    graph.ts            reading a v1 or v2 graph the same way
    portable.ts         the interchange format
    decisions.ts        decision models (Jev): request, strict answer parsing, the demo decider
    graphPrompt.ts      prompt the graph: the generator's prompt, validation, repair, edit ids
  components/           TopBar · Inspector · NodeInspector · GraphCanvas · AgentNode · FlowNodes ·
                        MessageEdge · TranscriptPanel · MemoryPanel · BlockLibrary · GateDialog · RunBar ·
                        GraphPromptDialog
```

## Stack

React 18 · TypeScript · Vite · MUI (Material Design 3 flavoured) · React Flow (`@xyflow/react`) ·
zustand. No backend, no database.

## Licence

MIT — see [LICENSE](LICENSE).
