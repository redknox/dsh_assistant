import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ingestLocalTextFile } from '../src/adapters/knowledge/local-file-ingest.js'
import { ObsidianVaultAccess, scanObsidianVault } from '../src/adapters/knowledge/obsidian-vault.js'
import { KnowledgeContractError } from '../src/domain/knowledge/normalize.js'
import { InMemoryKeywordIndex } from '../src/domain/knowledge/keyword-index.js'
import { KnowledgeService } from '../src/domain/knowledge/service.js'
import { InMemoryPersonalMemory } from '../src/domain/memory/service.js'
import { bootAssistantControl } from '../src/runtime/boot.js'

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'knowledge')

describe('knowledge contracts', () => {
  it('indexes an explicit Obsidian Vault read-only without following hidden folders or symlinks', () => {
    const vault = mkdtempSync(join(tmpdir(), 'tars-obsidian-vault-'))
    const outside = mkdtempSync(join(tmpdir(), 'tars-obsidian-outside-'))
    try {
      mkdirSync(join(vault, '.obsidian'))
      mkdirSync(join(vault, 'Projects'))
      mkdirSync(join(vault, '.private'))
      writeFileSync(join(vault, 'Projects', 'Apollo.md'), '# Apollo\n\nLaunch checklist and [[Team]].\n')
      writeFileSync(join(vault, 'Empty.md'), '')
      writeFileSync(join(vault, '.private', 'Secret.md'), '# Secret\n\nHidden material.\n')
      writeFileSync(join(outside, 'Outside.md'), '# Outside\n\nMust not be indexed.\n')
      symlinkSync(outside, join(vault, 'Linked'))

      const notes = scanObsidianVault(vault)
      assert.deepEqual(notes.map((note) => note.title), ['Apollo'])
      const knowledge = new KnowledgeService()
      for (const note of notes) knowledge.ingest(note)
      const result = knowledge.retrieve({ text: 'launch checklist' })
      assert.equal(result.hits.length, 1)
      assert.match(result.hits[0]?.citation.sourceUri ?? '', /Projects\/Apollo\.md$/)
      assert.equal(result.hits[0]?.citation.sourceKind, 'note')
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('creates without overwrite and appends only against the approved note version', () => {
    const vault = mkdtempSync(join(tmpdir(), 'tars-obsidian-write-'))
    try {
      mkdirSync(join(vault, '.obsidian'))
      const knowledge = new KnowledgeService()
      const access = new ObsidianVaultAccess(vault, (note) => knowledge.ingest(note))
      const create = access.proposeCreate('Projects/Apollo.md', '# Apollo\n\nRelated: [[Team]]')
      access.create(create.path, create.content)
      assert.match(readFileSync(join(vault, 'Projects', 'Apollo.md'), 'utf8'), /\[\[Team\]\]/)
      assert.throws(() => access.create(create.path, create.content), /already exists/)

      const stale = access.proposeAppend(create.path, 'First update')
      writeFileSync(join(vault, create.path), '# Apollo\n\nChanged elsewhere.\n')
      assert.throws(() => access.append(stale.path, stale.content, stale.expectedDigest!), /changed since the proposal/)
      const current = access.proposeAppend(create.path, 'Approved update')
      access.append(current.path, current.content, current.expectedDigest!)
      assert.match(readFileSync(join(vault, create.path), 'utf8'), /Approved update/)
      assert.equal(knowledge.listDocuments().length, 1)
      assert.equal(knowledge.retrieve({ text: 'Approved update' }).hits.length, 1)
      assert.throws(() => access.proposeCreate('../Escape.md', 'no'), /Vault-relative|forbidden/)
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('routes Obsidian creation through an exact L4 confirmation before writing', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'tars-obsidian-policy-vault-'))
    const home = mkdtempSync(join(tmpdir(), 'tars-obsidian-policy-home-'))
    mkdirSync(join(vault, '.obsidian'))
    const control = await bootAssistantControl({ home, knowledge: { obsidianVaultPath: vault } })
    try {
      const execute = async (name: string, args: Record<string, unknown>) => control.ctx.tools.execute({
        callId: CallId(`knowledge-${name}-${Math.random()}`),
        name,
        arguments: args,
        signal: AbortSignal.timeout(5_000),
      })
      const proposal = await execute('obsidian_propose_create_note', { path: 'Ideas/New Note.md', content: '# New Note\n\n[[Index]]' })
      assert.equal(proposal.isError, false)
      assert.equal(existsSync(join(vault, 'Ideas', 'New Note.md')), false)
      const pending = await execute('obsidian_create_note', { path: 'Ideas/New Note.md', content: '# New Note\n\n[[Index]]' })
      const pendingBody = JSON.parse(String(pending.value)) as { kind: string; confirmationId: string }
      assert.equal(pendingBody.kind, 'pending_confirmation')
      assert.equal(existsSync(join(vault, 'Ideas', 'New Note.md')), false)
      const approved = await control.ctx.actionPolicy.policy.resolve(pendingBody.confirmationId, 'approve')
      assert.equal(approved.kind, 'allow')
      assert.equal(existsSync(join(vault, 'Ideas', 'New Note.md')), true)
      assert.equal(control.ctx.personalKnowledge.retrieve({ text: 'New Note' }).hits.length, 1)
    } finally {
      await control.ctx.fiber.dispose()
      rmSync(vault, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

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
