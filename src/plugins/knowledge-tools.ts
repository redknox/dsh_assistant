import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { PersonalKnowledge } from '../domain/knowledge/types.js'
import type { ObsidianVaultAccess } from '../adapters/knowledge/obsidian-vault.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

export function registerKnowledgeTools(tools: Pick<ToolRuntime, 'register'>, knowledge: PersonalKnowledge, obsidian?: ObsidianVaultAccess): () => void {
  const disposers = [tools.register(defineTool({
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
  }))]
  if (obsidian) {
    disposers.push(
      tools.register(defineTool({
        name: 'obsidian_propose_create_note',
        description: 'Draft only: validate creating a new Markdown note inside the configured Obsidian Vault. Does not write. Use a Title Case .md path and include any related [[wikilinks]].',
        parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
        output: textOutput(),
        async execute(args, exec) {
          exec.signal.throwIfAborted()
          return JSON.stringify(obsidian.proposeCreate(args.path, args.content))
        },
      })),
      tools.register(defineTool({
        name: 'obsidian_propose_append_note',
        description: 'Draft only: validate appending Markdown to an existing Obsidian note and return its current digest. Does not write.',
        parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
        output: textOutput(),
        async execute(args, exec) {
          exec.signal.throwIfAborted()
          return JSON.stringify(obsidian.proposeAppend(args.path, args.content))
        },
      })),
    )
  }
  return () => { for (const dispose of [...disposers].reverse()) dispose() }
}
