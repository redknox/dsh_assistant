# Plan My Day vertical slice

Evidence for issue #10. Recorded **2026-08-21**. This slice is **Verified** by `npm test` (`test/vertical-slice.test.ts`) and can be replayed with `npm run slice`.

## What is real vs fake

| Path | Evidence |
| --- | --- |
| DSH public runtime (Cordis plugins, Session, Agent registry, Agent Loop, ToolRuntime, Jobs, events) | **Verified** — the slice sends a user message through `agent.followup()` and waits on `agent.whenIdle()` |
| Personal memory / knowledge services and tools | **Verified** — `recall_memory` and `retrieve_knowledge` run inside the loop |
| Policy + confirmation (L2 calendar create, one-shot approve, replay deny) | **Verified** — UI `approve()` executes the bound event once |
| UI projection (conversation, jobs, confirmations, memory, knowledge sources/hits) | **Verified** — snapshot/text surface after the run |
| LLM provider | **Implemented** only — `PlanMyDayAdapter` is a scripted local adapter, not a live model |
| Calendar / tasks / files / mail / contacts | **Implemented** only — `FakeIntegrationSuite`, not vendor accounts |
| Durable cross-restart jobs / real user reminders | **Unsupported** |

No application feature imports DSH package-internal Agent Loop classes or other DSH `src/*` paths.

## Runtime and configuration

- Product: `dsh-assistant` `0.1.0`
- Node: `>=22` (recorded run: local `npm test` / `npm run slice` on 2026-08-21)
- DSH packages pinned at **0.1.0-rc.8**: `@deepseek-ai/dsh-agent`, `dsh-agent-loop`, `dsh-invariants`, `dsh-jobs`, `dsh-jobs-local`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, and the other listed `0.1.0-rc.8` dependencies in `package.json`
- Boot: `bootAssistantRuntime({ knowledgeFixturePaths: [fixtures/knowledge/office-hours.md] })`
- Agent: `createAssistantAgent(ctx, 'plan-my-day', { provider: 'fake', model: 'plan-my-day' })`
- LLM registration: `ctx.llm.registerAdapter(['fake'], new PlanMyDayAdapter())`
- Policy: `EXAMPLE_PERSONAL_POLICY` (calendar execute = L2 confirmation)
- Test data: fixture `fixtures/knowledge/office-hours.md`; memory `Prefers a short morning brief` on topic `briefing`; fake calendar events `Team standup` / `Office hours` / `Retro`; proposed mutation `Focus block` at `2026-08-21T09:00:00.000Z`–`2026-08-21T10:00:00.000Z`
- No credentials or real personal data are committed

## Commands

```sh
npm install
npm run typecheck
npm test
npm run slice
```

`npm test` includes `test/vertical-slice.test.ts`. `npm run slice` prints the same control-surface snapshot after the happy path (plan → confirm → morning brief).

## Observed results (2026-08-21)

1. User input `Plan my day` wakes the idle agent. Session history contains `user/message`, tool calls/results for `recall_memory`, `retrieve_knowledge`, `calendar_list_events`, `calendar_propose_event`, `calendar_create_event`, and a final assistant summary that a focus block is pending confirmation.
2. UI snapshot shows the briefing preference, the office-hours knowledge source, and one pending L2 confirmation bound to `{ title, start, end }` of the focus block.
3. Approving that confirmation creates exactly one calendar event. A second approve is `deny/replay`; the calendar count does not increase again.
4. `morning-brief` job completes through public `ctx.jobs` and reports calendar/task/knowledge counts.
5. Cancellation: a registered `hold` workflow is started and cancelled; run status is `killed`.
6. Failure: a second user message `Try an invalid calendar query` drives `calendar_list_events` with `limit: -1`. The tool result contains `invalid_request`; the assistant reports the provider rejection.

Reproduce by re-running the commands above. Do not treat live DeepSeek/vendor APIs as **Verified**.
