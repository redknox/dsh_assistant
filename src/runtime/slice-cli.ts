import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PlanMyDayAdapter } from '../adapters/llm/plan-my-day-adapter.js'
import { AssistantControlSurface } from '../ui/controller.js'
import { renderAssistantViewAsText } from '../ui/surface.js'
import { bootAssistantRuntime, createAssistantAgent } from './boot.js'

const fixture = join(import.meta.dirname, '..', '..', 'fixtures', 'knowledge', 'office-hours.md')
const ctx = await bootAssistantRuntime({ knowledgeFixturePaths: [fixture] })
ctx.llm.registerAdapter(['fake'], new PlanMyDayAdapter())
const handle = await createAssistantAgent(ctx, 'plan-my-day', { provider: 'fake', model: 'plan-my-day' })
const ui = new AssistantControlSurface(ctx, 'plan-my-day')
const agent = ctx.agents.get(SessionId('plan-my-day'))
if (!agent) throw new Error('slice agent was not registered')

ui.remember({ category: 'preference', topicKey: 'briefing', statement: 'Prefers a short morning brief' })
ui.sendMessage('Plan my day')
await agent.whenIdle()
const pending = ui.snapshot().confirmations.find((item) => item.status === 'pending')
if (pending) await ui.approve(pending.id)
ui.retrieveKnowledge('print confirmation')
const brief = ui.startJob('morning-brief')
await ui.waitJob(brief.runId)

console.log(renderAssistantViewAsText(ui.snapshot()))
console.log('\n# Evidence')
console.log('DSH packages: 0.1.0-rc.8')
console.log('LLM: Fake PlanMyDayAdapter (Implemented, not a live provider)')
console.log('Integrations: FakeIntegrationSuite (Implemented, not vendor accounts)')

await handle.dispose()
await ctx.fiber.dispose()
