import { Context } from '@deepseek-ai/cordis'
import { bootAssistantRuntime, createAssistantAgent } from './boot.js'

const ctx = await bootAssistantRuntime()
const handle = await createAssistantAgent(ctx)
const live = ctx.agents.get(handle.agent.id)
if (!live) {
  throw new Error('assistant agent was not registered on ctx.agents')
}
console.log(`booted assistant session ${handle.agent.id}`)
await handle.dispose()
await ctx.fiber.dispose()
