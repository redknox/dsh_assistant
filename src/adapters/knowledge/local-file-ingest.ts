import { readFileSync } from 'node:fs'
import { KnowledgeContractError } from '../../domain/knowledge/normalize.js'
import type { KnowledgeIngestInput, KnowledgeSourceKind } from '../../domain/knowledge/types.js'

/** Local file ingest adapter. Parser/index DTOs stay here, not in the domain contract. */
export function ingestLocalTextFile(path: string, sourceKind: KnowledgeSourceKind = 'file'): KnowledgeIngestInput {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new KnowledgeContractError(`cannot read knowledge source: ${path}`, { cause: error })
  }
  return { sourceUri: path, sourceKind, text }
}
