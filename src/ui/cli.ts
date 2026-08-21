import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FakeReplyAdapter } from '../adapters/llm/fake-reply-adapter.js'
import { bootAssistantRuntime, createAssistantAgent } from '../runtime/boot.js'
import { AssistantControlSurface } from './controller.js'
import { renderAssistantViewAsText } from './surface.js'

const sessionId = 'ui-surface'
const fixture = join(import.meta.dirname, '..', '..', 'fixtures', 'knowledge', 'office-hours.md')
const ctx = await bootAssistantRuntime({ knowledgeFixturePaths: [fixture] })
ctx.llm.registerAdapter(['fake'], new FakeReplyAdapter('Print jobs need a desk confirmation.'))
const handle = await createAssistantAgent(ctx, sessionId, { provider: 'fake', model: 'fake-echo' })
const ui = new AssistantControlSurface(ctx, sessionId)
const agent = ctx.agents.get(SessionId(sessionId))
if (!agent) throw new Error('ui agent was not registered')

ui.sendMessage('What are the library desk hours?')
await agent.whenIdle()
ui.remember({ category: 'preference', topicKey: 'briefing', statement: 'Prefers a short morning brief' })
ui.retrieveKnowledge('print confirmation')
const brief = ui.startJob('morning-brief')
await ui.waitJob(brief.runId)
ui.requestExecute('files', 'delete', { id: 'f-1' })

console.log(renderAssistantViewAsText(ui.snapshot()))

await handle.dispose()
await ctx.fiber.dispose()
