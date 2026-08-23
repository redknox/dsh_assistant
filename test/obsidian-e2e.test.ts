import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ActivationDeniedError } from '../src/domain/governance/index.js'
import { obsidianVaultRiskModel } from '../src/domain/reliability/index.js'
import { CORE_KNOWN_SEAMS } from '../src/domain/resolution/index.js'
import { bootAssistantControl } from '../src/runtime/boot.js'

const root = join(import.meta.dirname, '..')
const fixtureVault = join(root, 'fixtures/obsidian-vault')
const candidateSource = join(root, 'fixtures/self-extension/obsidian-vault-candidate')
const OBSIDIAN_NEED = 'I want the Assistant to understand and operate an Obsidian Vault: search notes, read frontmatter/tags, resolve vault-relative notes, and create a new note containing Obsidian wikilinks.'

const OBSIDIAN_TOOLS = [
  'obsidian_notes_list',
  'obsidian_notes_read',
  'obsidian_notes_search',
  'obsidian_notes_create',
] as const

function copyCandidateSources(workspace: { writeFile(id: string, path: string, content: string): unknown }, id: string) {
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, relative)
      else workspace.writeFile(id, relative, readFileSync(full, 'utf8'))
    }
  }
  walk(candidateSource, '')
}

async function tool(ctx: { tools: { execute(input: unknown): Promise<{ isError: boolean; value?: unknown }> } }, name: string, args: Record<string, unknown>) {
  const result = await ctx.tools.execute({
    callId: CallId(`obsidian-${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(result.isError, false, String(result.value))
  return JSON.parse(String(result.value))
}

function reviewObsidian(ctx: { capabilityResolution: { review(input: object): { kind: string; implications: readonly string[] } } }) {
  return ctx.capabilityResolution.review({
    capability: 'obsidian.notes.read',
    need: OBSIDIAN_NEED,
    behavior: 'vault-relative identity, YAML frontmatter, #tags, and [[wikilinks]]',
    alreadySatisfied: false,
    inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
  })
}

describe.skip('Obsidian Self-Extension vertical slice (quarantined: needs isolated-runtime broker migration)', () => {
  it('A. does not treat files.read as complete Obsidian support', async () => {
    const { ctx } = await bootAssistantControl()
    try {
      const files = ctx.capabilityResolution.review({
        capability: 'files.read',
        need: 'list files through the existing fake files provider',
      })
      assert.equal(files.kind, 'reuse')
      const review = reviewObsidian(ctx)
      assert.equal(review.kind, 'new-plugin')
      assert.match(review.implications.join('\n'), /files\.read/)
      assert.match(review.implications.join('\n'), /insufficient/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs review → candidate → validation → approval → activation → vault use → rollback', async () => {
    const previous = process.env.DSH_ASSISTANT_OBSIDIAN_VAULT
    const vault = mkdtempSync(join(tmpdir(), 'obsidian-e2e-'))
    cpSync(fixtureVault, vault, { recursive: true })
    process.env.DSH_ASSISTANT_OBSIDIAN_VAULT = vault
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      assert.equal(ctx.capabilityRegistry.resolveActiveOwner('obsidian.notes.read').kind, 'unknown')
      for (const name of OBSIDIAN_TOOLS) assert.equal(ctx.tools.get(name), undefined)

      const review = reviewObsidian(ctx)
      assert.equal(review.kind, 'new-plugin')
      assert.match(review.implications.join('\n'), /must not register a second generic filesystem/)

      const created = ctx.candidateWorkspace.create({
        review,
        owner: 'generated/obsidian-vault',
        version: '0.1.0',
        manifest: {
          capabilities: ['obsidian.notes.list', 'obsidian.notes.read', 'obsidian.notes.search', 'obsidian.notes.create'],
          permissions: ['filesystem.vault.read', 'filesystem.vault.write'],
          runtimeSeams: ['obsidian.notes'],
          tools: [...OBSIDIAN_TOOLS],
          services: [],
          configRequired: ['vaultRoot'],
          effects: { filesystem: [vault], network: [], process: [] },
          entryPoints: ['src/plugin.js'],
          riskModel: obsidianVaultRiskModel(),
        },
      })
      copyCandidateSources(ctx.candidateWorkspace, created.id)
      ctx.candidateWorkspace.writeFile(created.id, 'vault.json', `${JSON.stringify({ vaultRoot: vault }, null, 2)}\n`)

      const report = ctx.candidateValidation.validate(created.id)
      assert.equal(report.passed, true, report.stages.map((item) => `${item.name}:${item.status}`).join(', '))
      assert.equal(report.stages.find((item) => item.name === 'tests')?.status, 'passed')
      const sealed = ctx.candidateWorkspace.seal(created.id)
      assert.equal(sealed.digest, report.digest)

      const diff = ctx.candidateWorkspace.diff(sealed.id)
      assert.ok(diff.capabilities.added.includes('obsidian.notes.read'))
      const summary = ctx.extensionGovernance.inspectSummary(sealed.id)
      assert.equal(summary.validationPassed, true)
      assert.ok(summary.permissions.added.includes('filesystem.vault.read'))
      assert.ok(summary.permissions.added.includes('filesystem.vault.write'))
      assert.ok(summary.effects.filesystem.includes(vault))
      assert.ok(summary.configRequired.includes('vaultRoot'))
      assert.deepEqual(summary.effects.network, [])
      assert.deepEqual(summary.effects.process, [])
      assert.deepEqual(summary.secrets, [])

      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      await assert.rejects(() => recoveryRoot.activate(sealed.id, human), ActivationDeniedError)

      const requested = ctx.extensionGovernance.requestApproval(sealed.id)
      recoveryRoot.recordApproval(human, {
        candidateId: sealed.id,
        fingerprint: requested.fingerprint,
        decision: 'approved-for-exact-diff',
      })
      const activated = await recoveryRoot.activate(sealed.id, human)
      assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics ?? activated.state)
      assert.equal(ctx.capabilityRegistry.get('generated/obsidian-vault', '0.1.0')?.status, 'active')
      for (const name of OBSIDIAN_TOOLS) assert.ok(ctx.tools.get(name), name)

      const listed = await tool(ctx, 'obsidian_notes_list', {})
      assert.ok(listed.some((item: { id: string }) => item.id === 'Projects/Alpha.md'))
      assert.ok(listed.some((item: { id: string }) => item.id === 'Notes/Alpha.md'))

      const alpha = await tool(ctx, 'obsidian_notes_read', { id: 'Projects/Alpha.md' })
      assert.equal(alpha.frontmatter.status, 'active')
      assert.ok(alpha.tags.includes('project'))
      assert.ok(alpha.wikilinks.includes('Alice'))

      const tagged = await tool(ctx, 'obsidian_notes_search', { tag: 'person' })
      assert.ok(tagged.some((item: { id: string }) => item.id === 'People/Alice.md'))

      const createdNote = await tool(ctx, 'obsidian_notes_create', {
        id: 'Projects/Beta.md',
        title: 'Beta',
        body: 'Spawned from the governed slice.',
        tags: 'project',
        wikilinks: 'Alice,Projects/Alpha',
      })
      assert.equal(createdNote.id, 'Projects/Beta.md')
      const reread = await tool(ctx, 'obsidian_notes_read', { id: 'Projects/Beta.md' })
      assert.ok(reread.wikilinks.includes('Alice'))
      assert.ok(reread.wikilinks.includes('Projects/Alpha'))

      const files = ctx.integrations.hub.files()
      const accesses = files.confinedAccesses()
      assert.ok(accesses.some((item) => item.op === 'list' && item.root === vault))
      assert.ok(accesses.some((item) => item.op === 'read' && item.path === 'Projects/Alpha.md'))
      assert.ok(accesses.some((item) => item.op === 'write' && item.path === 'Projects/Beta.md'))
      for (const source of ['src/plugin.js', 'src/notes.js']) {
        assert.doesNotMatch(readFileSync(join(candidateSource, source), 'utf8'), /node:fs/)
      }

      const outside = mkdtempSync(join(tmpdir(), 'obsidian-outside-'))
      writeFileSync(join(outside, 'secret.md'), '---\ntitle: leaked\n---\n#leaked leaked-body\n')
      symlinkSync(outside, join(vault, 'link'))
      const afterLink = await tool(ctx, 'obsidian_notes_list', {})
      assert.equal(afterLink.some((item: { id: string }) => item.id.includes('secret')), false)
      const leaked = await tool(ctx, 'obsidian_notes_search', { tag: 'leaked' })
      assert.equal(leaked.length, 0)
      await assert.rejects(() => tool(ctx, 'obsidian_notes_read', { id: 'link/secret.md' }))
      await assert.rejects(() => tool(ctx, 'obsidian_notes_create', {
        id: 'link/nested.md',
        title: 'nope',
      }))
      rmSync(outside, { recursive: true, force: true })

      await assert.rejects(() => tool(ctx, 'obsidian_notes_read', { id: '../outside.md' }))
      await assert.rejects(() => tool(ctx, 'obsidian_notes_create', {
        id: '../../secret.md',
        title: 'nope',
      }))

      const restored = await recoveryRoot.rollback(human)
      assert.equal(restored.state, 'rolled-back')
      assert.equal(ctx.capabilityRegistry.get('generated/obsidian-vault', '0.1.0')?.status, 'disabled')
      for (const name of OBSIDIAN_TOOLS) assert.equal(ctx.tools.get(name), undefined)
      assert.ok(ctx.tools.get('remember_memory'))
      assert.ok(ctx.tools.get('calendar_list_events'))
      assert.ok(ctx.personalMemory)
    } finally {
      if (previous === undefined) delete process.env.DSH_ASSISTANT_OBSIDIAN_VAULT
      else process.env.DSH_ASSISTANT_OBSIDIAN_VAULT = previous
      await ctx.fiber.dispose()
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('E. does not let a prior approval authorize a mutated candidate', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const review = reviewObsidian(ctx)
      const created = ctx.candidateWorkspace.create({
        review,
        owner: 'generated/obsidian-vault',
        version: '0.1.0',
        manifest: {
          capabilities: ['obsidian.notes.read'],
          tools: ['obsidian_notes_read'],
          entryPoints: ['src/plugin.js'],
        },
      })
      copyCandidateSources(ctx.candidateWorkspace, created.id)
      ctx.candidateValidation.validate(created.id)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      const first = ctx.extensionGovernance.requestApproval(created.id)
      recoveryRoot.recordApproval(human, {
        candidateId: created.id,
        fingerprint: first.fingerprint,
        decision: 'approved-for-exact-diff',
      })
      ctx.candidateWorkspace.writeFile(created.id, 'src/extra.js', 'export const mutated = true\n')
      const report = ctx.candidateValidation.validate(created.id)
      const sealed = ctx.candidateWorkspace.seal(created.id)
      assert.notEqual(report.digest, undefined)
      assert.ok(ctx.extensionGovernance.eligibility(sealed.id).denials.some((item) => item.reason === 'approval-stale'))
      await assert.rejects(() => recoveryRoot.activate(sealed.id, human), ActivationDeniedError)
      assert.equal(ctx.capabilityRegistry.get('generated/obsidian-vault', '0.1.0'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('G. restores LKG when the candidate artifact fails to mount', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const review = reviewObsidian(ctx)
      const created = ctx.candidateWorkspace.create({
        review,
        owner: 'generated/obsidian-broken',
        version: '0.1.0',
        manifest: {
          capabilities: ['obsidian.notes.read'],
          tools: ['obsidian_notes_read'],
          entryPoints: ['src/plugin.js'],
        },
      })
      ctx.candidateWorkspace.writeFile(created.id, 'package.json', `${JSON.stringify({
        name: 'dsh-generated-obsidian-broken',
        type: 'module',
        main: 'src/plugin.js',
      }, null, 2)}\n`)
      ctx.candidateWorkspace.writeFile(created.id, 'src/plugin.js', `export const name = 'generated-obsidian-broken'
export function apply() { throw new Error('obsidian candidate exploded') }
`)
      ctx.candidateValidation.validate(created.id)
      const sealed = ctx.candidateWorkspace.seal(created.id)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      const fingerprint = ctx.extensionGovernance.requestApproval(sealed.id).fingerprint
      recoveryRoot.recordApproval(human, { candidateId: sealed.id, fingerprint, decision: 'approved-for-exact-diff' })
      const status = await recoveryRoot.activate(sealed.id, human)
      assert.equal(status.state, 'activation-failed')
      assert.ok(status.lastFailure?.diagnostics)
      assert.equal(ctx.capabilityRegistry.get('generated/obsidian-broken', '0.1.0'), undefined)
      assert.equal(ctx.tools.get('obsidian_notes_read'), undefined)
      assert.ok(ctx.tools.get('remember_memory'))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
