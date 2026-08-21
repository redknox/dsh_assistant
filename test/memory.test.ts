import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { InMemoryPersonalMemory } from '../src/domain/memory/service.js'
import {
  MemoryContractError,
  normalizeWriteInput,
  polarityIsKnownFalse,
  polarityIsUnknown,
} from '../src/domain/memory/normalize.js'
import type { MemoryWriteInput, Provenance, SessionHistoryRef } from '../src/domain/memory/types.js'

const provenance: Provenance = {
  actor: 'user',
  mechanism: 'explicit_write',
  evidenceIds: ['user:confirm'],
  recordedAt: '2026-08-21T00:00:00.000Z',
}

function write(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    category: 'fact',
    topicKey: 'Lives In',
    statement: ' Lives in Beijing ',
    polarity: 'true',
    confidence: { kind: 'score', value: 0.9 },
    provenance,
    visibility: 'model',
    conflictPolicy: 'keep_both',
    ...overrides,
  }
}

describe('memory contracts', () => {
  it('normalizes topic and statement without coercing unknown to false', () => {
    const normalized = normalizeWriteInput(write({ polarity: 'unknown', confidence: { kind: 'unknown' } }))
    assert.equal(normalized.topicKey, 'lives in')
    assert.equal(normalized.statement, 'Lives in Beijing')
    assert.equal(polarityIsUnknown(normalized.polarity), true)
    assert.equal(polarityIsKnownFalse(normalized.polarity), false)
  })

  it('keeps conflicting active memories representable', () => {
    const memory = new InMemoryPersonalMemory()
    const first = memory.write(write({ statement: 'Lives in Beijing', polarity: 'true' }))
    const second = memory.write(write({ statement: 'Lives in Shanghai', polarity: 'true' }))
    const result = memory.query({ topicKey: 'lives in' })
    assert.equal(result.records.length, 2)
    assert.equal(result.conflicts.length, 1)
    assert.match(result.trace.why, /2 selected/)
    assert.ok(result.trace.selections.every((item) => item.reasons.includes('topicKey=lives in')))
    assert.ok(result.conflicts[0]?.recordIds.includes(first.record.id))
    assert.ok(result.conflicts[0]?.recordIds.includes(second.record.id))
  })

  it('replace supersedes the previous record instead of mutating it in place', () => {
    const memory = new InMemoryPersonalMemory()
    const created = memory.write(write({ statement: 'Prefers tea' }))
    const replaced = memory.replace(created.record.id, {
      statement: 'Prefers coffee',
      provenance: { ...provenance, recordedAt: '2026-08-21T01:00:00.000Z' },
    })
    const previous = memory.get(created.record.id)
    assert.equal(previous?.status, 'superseded')
    assert.equal(previous?.supersededBy, replaced.record.id)
    assert.equal(replaced.record.status, 'active')
    assert.equal(replaced.record.statement, 'Prefers coffee')
    assert.equal(memory.query().records.length, 1)
    assert.equal(memory.query({ includeSuperseded: true }).records.length, 2)
  })

  it('delete is a tombstone and is omitted from default retrieval', () => {
    const memory = new InMemoryPersonalMemory()
    const created = memory.write(write({ statement: 'Has a cat' }))
    const deleted = memory.delete(created.record.id, provenance)
    assert.equal(deleted.status, 'deleted')
    assert.ok(deleted.deletedAt)
    assert.equal(memory.query().records.length, 0)
    assert.equal(memory.query({ includeDeleted: true }).records[0]?.id, created.record.id)
  })

  it('refuses to treat session history as durable memory', () => {
    const memory = new InMemoryPersonalMemory()
    const session: SessionHistoryRef = { kind: 'dsh_session_history', sessionId: 'abc' }
    assert.throws(
      () => memory.write(session as unknown as MemoryWriteInput),
      MemoryContractError,
    )
  })
})

describe('source boundary', () => {
  it('does not import DSH package internals', () => {
    const root = join(import.meta.dirname, '..', 'src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith('.ts')) files.push(path)
      }
    }
    walk(root)
    const forbidden = /@deepseek-ai\/dsh-[^'"\s]+\/src\/|ReactLoopAgent/
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      assert.equal(forbidden.test(text), false, file)
    }
  })
})
