import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { JsonFileMemoryPersistence } from '../src/adapters/memory/json-file-persistence.js'
import { InMemoryPersistence } from '../src/domain/memory/persistence.js'
import { MemoryService } from '../src/domain/memory/service.js'
import type { MemoryWriteInput, Provenance } from '../src/domain/memory/types.js'

const provenance: Provenance = {
  actor: 'user',
  mechanism: 'explicit_write',
  evidenceIds: ['user:confirm'],
  recordedAt: '2026-08-21T00:00:00.000Z',
}

function write(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    category: 'preference',
    topicKey: 'drink',
    statement: 'Prefers tea',
    polarity: 'true',
    confidence: { kind: 'unknown' },
    provenance,
    visibility: 'model',
    conflictPolicy: 'keep_both',
    ...overrides,
  }
}

describe('replaceable persistence', () => {
  it('keeps domain behavior when swapping in-memory persistence instances', () => {
    const persistence = new InMemoryPersistence()
    const first = new MemoryService(persistence, { now: () => '2026-08-21T02:00:00.000Z', id: () => 'mem-1' })
    first.write(write())
    const second = new MemoryService(persistence, { now: () => '2026-08-21T03:00:00.000Z', id: () => 'mem-2' })
    assert.equal(second.get('mem-1')?.statement, 'Prefers tea')
    second.delete('mem-1', provenance)
    const third = new MemoryService(persistence)
    assert.equal(third.get('mem-1')?.status, 'deleted')
    assert.equal(third.query().records.length, 0)
  })

  it('round-trips CRUD through the local JSON file adapter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
    const filePath = join(dir, 'memory.json')
    try {
      let n = 0
      const persistence = new JsonFileMemoryPersistence(filePath)
      const writer = new MemoryService(persistence, { now: () => '2026-08-21T04:00:00.000Z', id: () => `json-${++n}` })
      writer.write(write({ statement: 'Prefers coffee' }))
      writer.write(write({ statement: 'Prefers tea', conflictPolicy: 'keep_both' }))

      const reader = new MemoryService(new JsonFileMemoryPersistence(filePath))
      const result = reader.query({ topicKey: 'drink' })
      assert.equal(result.records.length, 2)
      assert.equal(result.conflicts.length, 1)
      assert.match(result.trace.why, /topicKey=drink/)
      assert.ok(result.trace.selections[0]?.reasons.includes('topicKey=drink'))

      reader.replace('json-1', { statement: 'Prefers water', provenance })
      const tea = result.records.find((record) => record.statement === 'Prefers tea')
      reader.delete(tea?.id ?? '', provenance)

      const reloaded = new MemoryService(new JsonFileMemoryPersistence(filePath))
      const active = reloaded.query({ topicKey: 'drink' })
      assert.equal(active.records.length, 1)
      assert.equal(active.records[0]?.statement, 'Prefers water')
      assert.equal(reloaded.query({ topicKey: 'drink', includeDeleted: true, includeSuperseded: true }).records.length, 3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
