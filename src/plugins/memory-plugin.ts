import { Service, type Context } from '@deepseek-ai/cordis'
import { InMemoryPersonalMemory, renderModelVisibleMemory, type PersonalMemory } from '../domain/memory/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    personalMemory: PersonalMemory
  }
}

export class PersonalMemoryService extends Service implements PersonalMemory {
  constructor(
    ctx: Context,
    private readonly store: InMemoryPersonalMemory,
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

export const name = 'dsh-assistant-memory'
export const inject = ['systemPrompt']

/** Memory service + model-visible injection through public `ctx.systemPrompt.context`. */
export async function apply(ctx: Context) {
  const store = new InMemoryPersonalMemory()
  await ctx.plugin(class extends PersonalMemoryService {
    constructor(scope: Context) {
      super(scope, store)
    }
  })
  ctx.systemPrompt.context({
    name: 'personal-memory',
    order: 50,
    text() {
      return renderModelVisibleMemory(store).text
    },
  })
}
