import { createInterface } from 'node:readline'
import vm from 'node:vm'

type JsonObject = Record<string, unknown>
type AgentOptions = { label?: string; phase?: string; schema?: JsonObject; model?: string }

class FatalWorkflowError extends Error {
  readonly fatal = true
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextRequestId = 1
let currentPhase: string | undefined
let agentsStarted = 0
let maxTotalAgents = 1
let maxItemsPerCall = 1
let maxConcurrentAgents = 1
let cancelled = false

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function fail(message: string): never {
  throw new Error(message)
}

function plainJson(value: unknown, label: string): unknown {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    fail(`${label} is not JSON-serializable`)
  }
  if (serialized === undefined) return null
  return JSON.parse(serialized) as unknown
}

function assertActive(): void {
  if (cancelled) fail('workflow run was cancelled')
}

function agent(prompt: unknown, options: AgentOptions = {}): Promise<unknown> {
  assertActive()
  if (typeof prompt !== 'string' || prompt.trim() === '') fail('agent() requires a non-empty prompt string')
  const allowed = new Set(['label', 'phase', 'schema', 'model'])
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail(`agent() received unknown option: ${key}`)
  agentsStarted += 1
  if (agentsStarted > maxTotalAgents) fail(`workflow exceeded the ${maxTotalAgents}-agent limit`)
  const id = `a${nextRequestId++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({
      op: 'agent-request', id, seq: agentsStarted, prompt,
      label: options.label ?? prompt.slice(0, 80),
      ...(options.phase ?? currentPhase ? { phase: options.phase ?? currentPhase } : {}),
      ...(options.schema ? { schema: plainJson(options.schema, 'agent schema') } : {}),
      ...(options.model ? { model: options.model } : {}),
    })
  })
}

async function parallel(thunks: unknown): Promise<unknown[]> {
  assertActive()
  if (!Array.isArray(thunks)) fail('parallel() requires an array of functions')
  if (thunks.length > maxItemsPerCall) fail(`parallel() exceeds the ${maxItemsPerCall}-item limit`)
  if (thunks.some((item) => typeof item !== 'function')) fail('parallel() requires an array of functions')
  const results = new Array<unknown>(thunks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(maxConcurrentAgents, Math.max(1, thunks.length)) }, async () => {
    while (cursor < thunks.length) {
      const index = cursor++
      try {
        results[index] = await (thunks[index] as () => unknown)()
      } catch (error) {
        if (cancelled || (error instanceof FatalWorkflowError && error.fatal)) throw error
        results[index] = null
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
  assertActive()
  if (!Array.isArray(items)) fail('pipeline() requires an items array')
  if (items.length > maxItemsPerCall) fail(`pipeline() exceeds the ${maxItemsPerCall}-item limit`)
  if (stages.length < 1 || stages.some((stage) => typeof stage !== 'function')) fail('pipeline() requires function stages')
  return parallel(items.map((item, index) => async () => {
    let previous: unknown = item
    for (const stage of stages as Array<(previous: unknown, item: unknown, index: number) => unknown>) {
      previous = await stage(previous, item, index)
    }
    return previous
  }))
}

function phase(title: unknown): void {
  assertActive()
  if (typeof title !== 'string' || title.trim() === '') fail('phase() requires a non-empty title')
  currentPhase = title
  send({ op: 'phase', title })
}

function log(message: unknown): void {
  assertActive()
  if (typeof message !== 'string') fail('log() requires a string')
  send({ op: 'log', message: message.slice(0, 4096) })
}

async function start(message: JsonObject): Promise<void> {
  maxTotalAgents = Number(message.maxTotalAgents)
  maxItemsPerCall = Number(message.maxItemsPerCall)
  maxConcurrentAgents = Number(message.maxConcurrentAgents)
  const script = String(message.script ?? '')
  const args = plainJson(message.args, 'workflow args')
  try {
    const wrapped = `(async (args, agent, parallel, pipeline, phase, log) => {\n${script}\n})`
    const fn = new vm.Script(wrapped, { filename: 'governed-workflow.js' }).runInNewContext(Object.create(null), { timeout: 1_000 }) as Function
    const value = await fn(args, agent, parallel, pipeline, phase, log)
    send({ op: 'result', value: plainJson(value, 'workflow result'), agentsStarted })
  } catch (error) {
    send({ op: 'error', error: error instanceof Error ? error.message : String(error), agentsStarted })
  }
}

send({ op: 'ready' })
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (line.trim() === '') continue
  const message = JSON.parse(line) as JsonObject
  const op = String(message.op ?? '')
  if (op === 'start') void start(message)
  else if (op === 'agent-result' || op === 'agent-error') {
    const id = String(message.id ?? '')
    const waiter = pending.get(id)
    pending.delete(id)
    if (!waiter) continue
    if (op === 'agent-result') waiter.resolve(message.value)
    else waiter.reject(new FatalWorkflowError(String(message.error ?? 'child agent failed')))
  } else if (op === 'cancel') {
    cancelled = true
    for (const waiter of pending.values()) waiter.reject(new Error('workflow run was cancelled'))
    pending.clear()
  }
}
