import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import { MEMORY_CATEGORIES, type PersonalMemory } from '../domain/memory/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/** Thin adapters: explicit user-controlled remember/forget/recall. No silent session ingestion. */
export function registerMemoryTools(tools: Pick<ToolRuntime, 'register'>, memory: PersonalMemory): () => void {
  const disposeRemember = tools.register(defineTool({
    name: 'remember_memory',
    description: 'Store durable personal memory only when the user explicitly asked to remember this fact. Never infer from ordinary chat or session history.',
    parameters: {
      category: { type: 'string', enum: MEMORY_CATEGORIES, required: true },
      topicKey: { type: 'string', required: true },
      statement: { type: 'string', required: true },
      polarity: { type: 'string', enum: ['true', 'false', 'unknown'] },
    },
    output: textOutput(),
    async execute(args) {
      const result = memory.write({
        category: args.category,
        topicKey: args.topicKey,
        statement: args.statement,
        polarity: args.polarity === 'true' || args.polarity === 'false' || args.polarity === 'unknown' ? args.polarity : 'unknown',
        confidence: { kind: 'unknown' },
        provenance: {
          actor: 'user',
          mechanism: 'explicit_write',
          evidenceIds: ['tool:remember_memory'],
          recordedAt: new Date().toISOString(),
        },
        visibility: 'model',
        conflictPolicy: 'keep_both',
      })
      return JSON.stringify({
        recordId: result.record.id,
        supersededIds: result.supersededIds,
        conflictTopicKeys: result.conflicts.map((group) => group.topicKey),
      })
    },
  }))

  const disposeForget = tools.register(defineTool({
    name: 'forget_memory',
    description: 'Delete a durable personal memory by id. Only when the user explicitly asked to forget it.',
    parameters: {
      id: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      const deleted = memory.delete(args.id, {
        actor: 'user',
        mechanism: 'explicit_write',
        evidenceIds: ['tool:forget_memory'],
        recordedAt: new Date().toISOString(),
      })
      return JSON.stringify({ id: deleted.id, status: deleted.status, deletedAt: deleted.deletedAt })
    },
  }))

  const disposeRecall = tools.register(defineTool({
    name: 'recall_memory',
    description: 'Retrieve durable personal memories by basic filters and explain which records were selected and why.',
    parameters: {
      topicKey: { type: 'string' },
      category: { type: 'string', enum: MEMORY_CATEGORIES },
    },
    output: textOutput(),
    async execute(args) {
      const result = memory.query({
        topicKey: args.topicKey,
        category: args.category,
        visibility: 'model',
      })
      return JSON.stringify({
        why: result.trace.why,
        selections: result.trace.selections,
        records: result.records.map((record) => ({
          id: record.id,
          topicKey: record.topicKey,
          statement: record.statement,
          polarity: record.polarity,
          category: record.category,
        })),
      })
    },
  }))

  return () => {
    disposeRecall()
    disposeForget()
    disposeRemember()
  }
}
