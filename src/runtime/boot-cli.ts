import { bootAssistantRuntime, createAssistantAgent } from './boot.js'
import type { MemoryPluginConfig } from '../plugins/memory-plugin.js'

function envList(name: string): string[] | undefined {
  const raw = process.env[name]
  if (!raw?.trim()) return undefined
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function memoryConfig(): MemoryPluginConfig | undefined {
  if (process.env.DSH_ASSISTANT_MEMORY !== 'json-file') return undefined
  return {
    persistence: 'json-file',
    ...(process.env.DSH_ASSISTANT_MEMORY_PATH
      ? { jsonFilePath: process.env.DSH_ASSISTANT_MEMORY_PATH }
      : {}),
  }
}

const ctx = await bootAssistantRuntime({
  knowledgeFixturePaths: envList('DSH_ASSISTANT_KNOWLEDGE_FIXTURES'),
  memory: memoryConfig(),
})
const handle = await createAssistantAgent(ctx)
const live = ctx.agents.get(handle.agent.id)
if (!live) {
  throw new Error('assistant agent was not registered on ctx.agents')
}
console.log(`booted assistant session ${handle.agent.id}`)
await handle.dispose()
await ctx.fiber.dispose()
