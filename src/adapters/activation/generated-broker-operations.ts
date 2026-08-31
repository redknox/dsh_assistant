import type { Context } from '@deepseek-ai/cordis'
import {
  GeneratedBrokerError,
  GeneratedHostBroker,
  HOST_KNOWLEDGE_RETRIEVE,
  textEchoBrokerOperation,
  type GeneratedBrokerOperation,
} from '../../domain/generated-runtime/index.js'

const MAX_QUERY_BYTES = 2 * 1024
const MAX_HITS = 5

function knowledgeOperation(ctx: Context): GeneratedBrokerOperation {
  return {
    capability: HOST_KNOWLEDGE_RETRIEVE,
    execute(args, execution) {
      execution.signal.throwIfAborted()
      if (Object.keys(args).some((key) => key !== 'query' && key !== 'limit')) {
        throw new GeneratedBrokerError('host.knowledge.retrieve received an unknown argument')
      }
      if (typeof args.query !== 'string' || args.query.trim() === '') {
        throw new GeneratedBrokerError('host.knowledge.retrieve query must be a non-empty string')
      }
      if (Buffer.byteLength(args.query, 'utf8') > MAX_QUERY_BYTES) {
        throw new GeneratedBrokerError(`host.knowledge.retrieve query exceeds the ${MAX_QUERY_BYTES}-byte limit`)
      }
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > MAX_HITS)) {
        throw new GeneratedBrokerError(`host.knowledge.retrieve limit must be an integer from 1 to ${MAX_HITS}`)
      }
      const knowledge = ctx.get('personalKnowledge')
      if (!knowledge) throw new GeneratedBrokerError('host.knowledge.retrieve is unavailable')
      const result = knowledge.retrieve({ text: args.query, limit: args.limit === undefined ? undefined : Number(args.limit) })
      return {
        why: result.trace.why,
        hits: result.hits.map((hit) => ({
          citation: hit.citation,
          score: hit.score,
          reasons: hit.reasons,
        })),
      }
    },
  }
}

/** Product adapter set for the host-owned generated capability Broker seam. */
export function createGeneratedHostBroker(ctx: Context): GeneratedHostBroker {
  return new GeneratedHostBroker([
    textEchoBrokerOperation,
    knowledgeOperation(ctx),
  ])
}
