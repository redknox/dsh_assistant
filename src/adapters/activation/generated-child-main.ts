import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

type Tool = {
  readonly name: string
  readonly description?: string
  readonly parameters?: Record<string, unknown>
  readonly output?: { schema?: Record<string, unknown> }
  execute?(args: Record<string, unknown>): Promise<unknown> | unknown
}

const tools = new Map<string, Tool>()
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const disposers: Array<() => Promise<unknown> | unknown> = []
let nextHostId = 1

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function brokerRequest(capability: string, args: Record<string, unknown>): Promise<unknown> {
  const id = `h${nextHostId++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, op: 'broker-request', capability, args })
  })
}

function descriptors(): Record<string, unknown>[] {
  return [...tools.values()]
    .filter((tool) => tool.name !== '*')
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? `Isolated generated proxy for ${tool.name}`,
      parameters: tool.parameters ?? {},
      output: tool.output?.schema ?? { type: 'string' },
    }))
}

function shimContext() {
  return {
    tools: {
      register(tool: Tool) {
        tools.set(tool.name, tool)
        return () => {
          tools.delete(tool.name)
        }
      },
      get(name: string) {
        return tools.get(name)
      },
    },
    effect(setup: () => (() => Promise<unknown> | unknown) | void) {
      if (typeof setup !== 'function') {
        throw new TypeError('ctx.effect accepts a cleanup setup function only')
      }
      const dispose = setup()
      if (dispose !== undefined && typeof dispose !== 'function') {
        throw new TypeError('ctx.effect setup must return a cleanup function or void')
      }
      if (dispose !== undefined) disposers.push(dispose)
      let active = true
      return async () => {
        if (!active || dispose === undefined) return
        active = false
        const index = disposers.indexOf(dispose)
        if (index >= 0) disposers.splice(index, 1)
        await dispose()
      }
    },
    broker: {
      request: brokerRequest,
    },
    get(_name: string) {
      throw new Error('live host context is not available to generated extensions')
    },
    plugin() {
      throw new Error('generated extensions cannot mount host plugins')
    },
  }
}

async function disposeEffects(): Promise<void> {
  const errors: unknown[] = []
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      await dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'generated extension cleanup failed')
}

async function loadCandidate(): Promise<void> {
  const artifact = process.env.DSH_GENERATED_ARTIFACT
  const relative = process.env.DSH_GENERATED_ENTRY
  if (!artifact || !relative) throw new Error('generated child is missing artifact coordinates')
  const entry = path.resolve(artifact, relative)
  const imported = await import(pathToFileURL(entry).href) as {
    default?: { apply?: (ctx: unknown) => unknown }
    apply?: (ctx: unknown) => unknown
    execute?: (tool: string, args: Record<string, unknown>) => unknown
  }
  const plugin = imported.default ?? imported
  const apply = plugin.apply ?? imported.apply
  if (typeof apply === 'function') {
    await apply(shimContext())
    return
  }
  if (typeof imported.execute === 'function') {
    tools.set('*', { name: '*', execute: (args) => imported.execute!(String(args.tool ?? ''), args) })
  }
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = String(message.id ?? '')
  const op = String(message.op ?? '')
  if (op === 'broker-result') {
    const waiter = pending.get(id)
    pending.delete(id)
    if (waiter === undefined) return
    if (message.ok === true) waiter.resolve(message.value)
    else waiter.reject(new Error(String(message.error ?? 'broker denied')))
    return
  }
  try {
    if (op === 'health') {
      send({ id, ok: true, tools: descriptors().map((item) => item.name), descriptors: descriptors() })
      return
    }
    if (op === 'call') {
      const name = String(message.tool ?? '')
      const tool = tools.get(name) ?? tools.get('*')
      if (tool?.execute === undefined) throw new Error(`unknown generated tool: ${name}`)
      const value = await tool.execute({ ...(message.args as Record<string, unknown> ?? {}), tool: name })
      send({ id, ok: true, value })
      return
    }
    if (op === 'shutdown') {
      await disposeEffects()
      send({ id, ok: true })
      setImmediate(() => process.exit(0))
      return
    }
    throw new Error(`unknown generated protocol op: ${op}`)
  } catch (error) {
    send({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

console.log = (...args: unknown[]) => {
  console.error(...args)
}

await loadCandidate()
send({ op: 'ready', tools: descriptors().map((item) => item.name), descriptors: descriptors() })

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (line.trim() === '') continue
  void handle(JSON.parse(line) as Record<string, unknown>)
}
