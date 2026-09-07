import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ensureProductHome } from '../src/product/home.js'
import { createUserAssetBackup, ensureDailyUserAssetBackup, rehearseUserAssetRestore } from '../src/product/user-assets-backup.js'
import { ReliabilityJournal, RuntimeReliabilityObserver } from '../src/product/reliability.js'
import type { ApprovalCard } from '../src/domain/workspace/types.js'

describe('daily user asset backup', () => {
  it('backs up sessions, memory and non-secret config, then performs a real restore drill', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-assets-'))
    try {
      const layout = ensureProductHome(path.join(root, 'home'))
      const sessions = path.join(layout.root, 'sessions')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(path.join(sessions, 'main.jsonl'), '{"type":"user/message"}\n')
      writeFileSync(layout.memoryFile, '{"records":[]}\n')
      mkdirSync(path.join(layout.root, 'attachments', 'v1', 'sha256'), { recursive: true })
      writeFileSync(path.join(layout.root, 'attachments', 'v1', 'sha256', 'image.bin'), 'image bytes')
      writeFileSync(layout.productConfigFile, '{"schemaVersion":1,"allowFixtures":false}\n')
      writeFileSync(layout.envFile, 'DEEPSEEK_API_KEY=must-not-be-backed-up\n')
      const destination = path.join(layout.backups, 'manual')
      const manifest = createUserAssetBackup({ layout, sessionDirectory: sessions, destination, now: new Date('2026-09-07T08:00:00Z') })
      assert.deepEqual(manifest.includes, ['sessions', 'attachments', 'memory', 'product-config', 'non-secret-settings'])
      assert.equal(readFileSync(path.join(destination, 'attachments', 'v1', 'sha256', 'image.bin'), 'utf8'), 'image bytes')
      assert.equal(existsSync(path.join(destination, 'config', 'env')), false)
      assert.doesNotMatch(JSON.stringify(manifest), /must-not-be-backed-up/)
      const settings = readFileSync(path.join(destination, 'config', 'settings.json'), 'utf8')
      assert.doesNotMatch(settings, /must-not-be-backed-up|DEEPSEEK_API_KEY/)
      const drill = rehearseUserAssetRestore(destination)
      assert.equal(drill.ok, true)
      assert.equal(drill.filesVerified, 5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates at most one daily snapshot and persists its restore-drill evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-daily-'))
    try {
      const layout = ensureProductHome(path.join(root, 'home'))
      const sessions = path.join(layout.root, 'sessions')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(path.join(sessions, 'main.jsonl'), '{}\n')
      const now = new Date('2026-09-07T08:00:00Z')
      assert.equal(ensureDailyUserAssetBackup({ layout, sessionDirectory: sessions, now }).state, 'created')
      const second = ensureDailyUserAssetBackup({ layout, sessionDirectory: sessions, now })
      assert.equal(second.state, 'current')
      assert.equal(JSON.parse(readFileSync(path.join(second.path, 'restore-drill.json'), 'utf8')).ok, true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('reliability observation', () => {
  it('records bounded P0/P1 events and detects a stuck approval once', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-reliability-'))
    let now = new Date('2026-09-07T00:00:00Z')
    try {
      const journal = new ReliabilityJournal(path.join(root, 'events.jsonl'), () => now)
      journal.record({ severity: 'P0', category: 'startup', code: 'START_FAILED', message: 'secret=redacted test failure' })
      const observer = new RuntimeReliabilityObserver(journal, () => now)
      const card = { id: 'apr-1', kind: 'dsh-tool', title: 'Approval', target: 'files_write', sideEffect: 'write', authorityChange: 'none', details: [], fingerprint: 'fp', status: 'pending' } satisfies ApprovalCard
      observer.inspectApprovals([card], 1_000)
      now = new Date('2026-09-07T00:00:02Z')
      observer.inspectApprovals([card], 1_000)
      observer.inspectApprovals([card], 1_000)
      const summary = journal.summary()
      assert.equal(summary.p0, 1)
      assert.equal(summary.p1, 1)
      assert.equal(summary.byCategory.approval, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
