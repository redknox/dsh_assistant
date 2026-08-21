import { Service, type Context } from '@deepseek-ai/cordis'
import { JsonFileMemoryPersistence } from '../adapters/memory/json-file-persistence.js'
import {
  InMemoryPersistence,
  MemoryService,
  renderModelVisibleMemory,
  type PersonalMemory,
} from '../domain/memory/index.js'
import { registerMemoryTools } from './memory-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    personalMemory: PersonalMemory
  }
}

export class PersonalMemoryService extends Service implements PersonalMemory {
  constructor(
    ctx: Context,
    private readonly store: PersonalMemory,
  ) {
    super(ctx, 'personalMemory')
  }

  get(id: string) {
    return this.store.get(id)
  }

  query(query?: Parameters<PersonalMemory['query']>[0]) {
    return this.store.query(query)
  }

  write(input: Parameters<PersonalMemory['write']>[0]) {
    return this.store.write(input)
  }

  replace(id: string, input: Parameters<PersonalMemory['replace']>[1]) {
    return this.store.replace(id, input)
  }

  delete(id: string, provenance: Parameters<PersonalMemory['delete']>[1]) {
    return this.store.delete(id, provenance)
  }
}

export interface MemoryPluginConfig {
  persistence?: 'memory' | 'json-file'
  jsonFilePath?: string
}

export const name = 'dsh-assistant-memory'
export const inject = ['systemPrompt', 'tools']

/** Memory service, optional JSON persistence, prompt injection, and explicit remember/forget/recall tools. */
export async function apply(ctx: Context, config: MemoryPluginConfig = {}) {
  const persistence = config.persistence === 'json-file'
    ? new JsonFileMemoryPersistence(config.jsonFilePath ?? '.dsh-assistant/memory.json')
    : new InMemoryPersistence()
  const memory = new MemoryService(persistence)
  await ctx.plugin(class extends PersonalMemoryService {
    constructor(scope: Context) {
      super(scope, memory)
    }
  })
  ctx.systemPrompt.context({
    name: 'personal-memory',
    order: 50,
    text() {
      return renderModelVisibleMemory(memory).text
    },
  })
  ctx.effect(() => registerMemoryTools(ctx.tools, memory))
}
