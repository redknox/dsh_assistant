import { join } from 'node:path'
import { bootAssistantRuntime, createAssistantAgent } from '../runtime/boot.js'
import { AssistantControlSurface } from './controller.js'
import { renderAssistantViewAsText } from './surface.js'

const sessionId = 'ui-surface'
const fixture = join(import.meta.dirname, '..', '..', 'fixtures', 'knowledge', 'office-hours.md')
const ctx = await bootAssistantRuntime({ knowledgeFixturePaths: [fixture] })
const handle = await createAssistantAgent(ctx, sessionId)
const ui = new AssistantControlSurface(ctx, sessionId)

ui.sendMessage('What are the library desk hours?')
ui.remember({ category: 'preference', topicKey: 'briefing', statement: 'Prefers a short morning brief' })
ui.retrieveKnowledge('print confirmation')
const brief = ui.startJob('morning-brief')
await ui.waitJob(brief.runId)
ui.requestExecute('files', 'delete', { id: 'f-1' })

console.log(renderAssistantViewAsText(ui.snapshot()))

await handle.dispose()
await ctx.fiber.dispose()
