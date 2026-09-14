# Adversarial review — 14 September 2026

Six hostile lenses were pointed at this repo (engine correctness, the provider layer, a stranger's
first minute, touch and accessibility, state and persistence, and "what would a senior reviewer
doubt"), each capped at three findings, followed by an independent pass whose only job was to
**refute** them. The review was killed by an infrastructure failure before its synthesis stage, so
the findings were harvested from its journal instead.

This file is the audit trail: **every finding, its status, and where it landed.** A review whose
recommendations are "taken into account" in someone's head is a review that was not taken into
account.

Status legend: **fixed** (code changed, test added where the defect was testable) ·
**by construction** (already impossible in this code, with the reason) · **declined** (a judgement
call, with the reason).

## Engine and run lifecycle

| # | Finding | Status | Where |
| --- | --- | --- | --- |
| 1 | In manager topology the reply round animated **backwards**: the reply reused its link's id, so the packet flew manager→worker while the message went worker→manager. Found independently by three lenses. | **fixed** | `engine/runner.ts` emits `TransitPacket{id, reversed}`; `MessageEdge` walks `keyPoints="1;0"`. Test: *a manager-mode reply is marked as travelling backwards*. |
| 2 | One agent's provider error killed the run **while its siblings kept streaming** into a transcript already marked failed. | **fixed** | An inner abort signal shared by a round, plus `allSettled`. Test: *one agent failing stops its siblings*. |
| 3 | `loadPreset` never fenced the running swarm: a ghost run kept appending messages signed by agents the new preset had never heard of. | **fixed** | `haltRun()` bumps the run generation and aborts. Test: *switching preset mid-run leaves no message signed by an agent that no longer exists*. |
| 4 | Stopping during the wake-up stagger left nodes badged **queued** for ever. | **fixed** | The runner tracks a `queued` set and clears it in `finally`. |
| 5 | **Stop overwrote the partial answer** with "(stopped)", discarding text the user had just watched arrive. | **fixed** | New `stopped` status keeps the text. Test: *Stop keeps the words that already arrived*. |
| 6 | A **stale runner wrote its final phase into the next run**. | **fixed** | Every callback is gated on a run generation. Test: *a restart is not polluted by the runner it replaced*. |
| 7 | A dead node prop (`tokensOut`, hardwired to 0) and a `paused` phase no code could produce. | **fixed** | The prop is gone; `paused` is now a real phase with pause/resume behind it. |

## Providers and the network

| # | Finding | Status | Where |
| --- | --- | --- | --- |
| 8 | A **200 response carrying an error** instead of SSE deltas became an empty message, so a misconfigured endpoint looked like a laconic model. | **fixed** | `chatCompletions` tracks whether a stream was ever seen and reports the body as the error it is. |
| 9 | Switching a provider away from Demo **kept `demo-fast`**, so the first real call 404'd on a model id that only ever existed locally. | **fixed** | `modelForProvider()`; the field then reads "No model set — this run would fail" in red. |
| 10 | A model that refuses `temperature` killed the run. | **fixed** | The refusal is recognised from its text, remembered per model, and the call retried without it. Tests in `engine/temperature.test.ts`. |
| 11 | `max_tokens` is hardcoded to 1024 on the Anthropic path. | **declined** | Real, and deliberately left: a demo's agents answer in one short paragraph, and an unbounded budget on a shared key is the worse failure. Noted here rather than silently kept. |

## First minute, touch, accessibility

| # | Finding | Status | Where |
| --- | --- | --- | --- |
| 12 | **Canned demo text ignored the task** and nothing said it was canned, so a first run read as a broken product. | **fixed** | The demo provider answers in character for the shipped presets, and every demo message carries a `demo` chip explaining what it is. |
| 13 | Light-mode per-agent hues measured **2.53:1** against the background while carrying speaker names — decoration standing in for information. | **fixed** | Lightness 44% → 29%. `theme.test.ts` measures all eight hues in both modes, so it cannot regress silently. |
| 14 | Inspector rows and colour swatches were **click-only divs**: no focus, no accessible name, 22px targets. | **fixed** | Rows are `role="button"` with a name and Enter/Space; swatches are real buttons named by colour, 28px. |
| 15 | On a phone, a running swarm **could not be stopped** from the Agents or Log sheet: the sheets are modal and the bottom bar sits behind them. | **fixed** | Pause/Resume/Stop in the transcript composer and in the Agents sheet header, on small screens only. Test: *at phone width the transcript sheet can pause and stop the run on its own*. |
| 16 | `Ctrl/⌘+A` ticks every agent, so the next **Backspace wiped the whole swarm**. | **fixed** | Delete only ever removes the one selected agent; bulk deletion stays a button that states the count. |
| 17 | Node selection was described as synced one-way, so Delete could remove an agent nothing on the canvas showed as selected. | **by construction** | The canvas mirrors `selectedId` from the store into each node's `selected`, so the highlight and the keyboard target are the same value. Nothing to change; recorded so the claim is not simply dropped. |

## Found later by the probes the review left behind

| Finding | Status | Where |
| --- | --- | --- |
| Typing 60 characters of prompt filled a 50-deep undo stack, making a deleted agent unrecoverable while undo still *looked* like it worked. | **fixed** | Text edits stay out of the history, and an undo carries typed prose forward. Tests in `store.test.ts`. |
| A bulk model apply could not be undone, and undoing a provider switch left provider and model mismatched. | **fixed** | `model` is deliberately not carried across an undo. Test: *a bulk model apply is undoable, provider and model together*. |

## What this review cost, and what it was worth

Thirteen agents, six lenses, one refutation pass each. Of seventeen findings, **fifteen were real and
are fixed**, one was declined with a reason, one was already impossible. The three highest-value ones
— the backwards animation, the contrast failure, and the sibling-streaming bug — were all invisible
to the existing tests, and two of them were invisible to the author because there is no browser on
the machine that wrote this code.
