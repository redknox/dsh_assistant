import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { PersonalKnowledge } from '../domain/knowledge/types.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

export function registerKnowledgeTools(tools: Pick<ToolRuntime, 'register'>, knowledge: PersonalKnowledge): () => void {
  const dispose = tools.register(defineTool({
    name: 'retrieve_knowledge',
    description: 'Retrieve curated reference material (files/notes). Results are citations, not personal memory. Do not write hits into remember_memory.',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer' },
    },
    output: textOutput(),
    async execute(args) {
      const result = knowledge.retrieve({ text: args.query, limit: args.limit })
      return JSON.stringify({
        why: result.trace.why,
        hits: result.hits.map((hit) => ({
          citation: hit.citation,
          score: hit.score,
          reasons: hit.reasons,
        })),
      })
    },
  }))
  return dispose
}
