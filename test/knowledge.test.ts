import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ingestLocalTextFile } from '../src/adapters/knowledge/local-file-ingest.js'
import { KnowledgeContractError } from '../src/domain/knowledge/normalize.js'
import { InMemoryKeywordIndex } from '../src/domain/knowledge/keyword-index.js'
import { KnowledgeService } from '../src/domain/knowledge/service.js'
import { InMemoryPersonalMemory } from '../src/domain/memory/service.js'

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'knowledge')

describe('knowledge contracts', () => {
  it('ingests local fixtures, keeps missing titles missing, and cites sources', () => {
    const knowledge = new KnowledgeService(new InMemoryKeywordIndex(), {
      now: () => '2026-08-21T05:00:00.000Z',
      id: () => 'doc-office',
    })
    const document = knowledge.ingest(ingestLocalTextFile(join(fixtures, 'office-hours.md'), 'fixture'))
    assert.equal(document.title, 'Library desk')
    assert.equal(document.sourceKind, 'fixture')
    const result = knowledge.retrieve({ text: 'print jobs confirmation' })
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0]?.citation.sourceUri, join(fixtures, 'office-hours.md'))
    assert.equal(result.hits[0]?.citation.title, 'Library desk')
    assert.match(result.hits[0]?.citation.excerpt ?? '', /Print jobs/)
    assert.match(result.trace.why, /selected 1 chunk/)
  })

  it('does not invent a title when the source has none', () => {
    const knowledge = new KnowledgeService()
    const document = knowledge.ingest(ingestLocalTextFile(join(fixtures, 'untitled.txt'), 'note'))
    assert.equal(document.title, undefined)
    const result = knowledge.retrieve({ text: 'front desk keys' })
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0]?.citation.title, undefined)
  })

  it('returns an empty retrieval when nothing matches', () => {
    const knowledge = new KnowledgeService()
    knowledge.ingest(ingestLocalTextFile(join(fixtures, 'office-hours.md'), 'fixture'))
    const result = knowledge.retrieve({ text: 'quantum cryptography unicorn' })
    assert.equal(result.hits.length, 0)
    assert.match(result.trace.why, /no lexical matches/)
  })

  it('rejects empty and malformed sources', () => {
    const knowledge = new KnowledgeService()
    assert.throws(
      () => knowledge.ingest(ingestLocalTextFile(join(fixtures, 'empty.txt'), 'file')),
      KnowledgeContractError,
    )
    assert.throws(
      () => knowledge.ingest({ sourceUri: 'mem://bad', sourceKind: 'note', text: 'ok\0binary' }),
      KnowledgeContractError,
    )
  })

  it('does not write retrieval hits into personal memory', () => {
    const knowledge = new KnowledgeService()
    const memory = new InMemoryPersonalMemory()
    knowledge.ingest(ingestLocalTextFile(join(fixtures, 'office-hours.md'), 'fixture'))
    knowledge.retrieve({ text: 'library desk' })
    assert.equal(memory.query().records.length, 0)
  })
})
