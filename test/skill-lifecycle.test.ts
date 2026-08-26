import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ReviewService } from '../src/domain/review/index.js'
import { TrustedAuthorityCredential } from '../src/domain/governance/types.js'
import { SkillAuthorityError, SkillContractError, SkillService } from '../src/domain/skill/index.js'
import { SAFE_MODE_TOOL_NAMES } from '../src/product/bundle.js'
import { bootAssistantControl, bootSafeModeRuntime } from '../src/runtime/boot.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/skills/weekly-review', import.meta.url))

function home(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-ng-skill-'))
}

function humanCred(rootId: symbol) {
  return new TrustedAuthorityCredential(rootId, { kind: 'human-control', source: 'operator-cli' })
}

async function authorApproved(service: SkillService, source = FIXTURE) {
  const imported = await service.importLocal(source)
  await service.validate(imported.candidateId)
  service.seal(imported.candidateId)
  const review = new ReviewService()
  const reviewed = service.requestReview(imported.candidateId, review)
  assert.equal(reviewed.report.state, 'review-complete')
  const requested = service.requestApproval(imported.candidateId, review)
  return { imported, requested, review }
}

describe('skill lifecycle', () => {
  it('imports a local bundle as an inactive third-party candidate', async () => {
    const service = new SkillService(home(), 'assistant')
    const imported = await service.importLocal(FIXTURE)
    assert.equal(imported.status, 'imported')
    assert.equal(imported.name, 'weekly-review')
    assert.equal(imported.provenance.origin, 'import')
    assert.equal(imported.sealed, false)
    assert.equal(imported.nextAction, 'validate')
    const inspect = service.inspect(imported.candidateId)
    assert.equal(inspect.lifecycle, 'imported')
    assert.equal(inspect.sealed, false)
    assert.equal(service.catalogNames().length, 0)
  })

  it('rejects traversal, symlink, executable files, and secret metadata', async () => {
    const service = new SkillService(home(), 'assistant')
    const bad = mkdtempSync(path.join(tmpdir(), 'skill-bad-'))
    writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: bad\ndescription: x\napi_key: secret\n---\nbody\n')
    await assert.rejects(() => service.importLocal(bad), SkillContractError)
    const exec = mkdtempSync(path.join(tmpdir(), 'skill-exec-'))
    writeFileSync(path.join(exec, 'SKILL.md'), '---\nname: exec\ndescription: xxxx\n---\nbody text\n')
    writeFileSync(path.join(exec, 'run.sh'), '#!/bin/sh\n')
    await assert.rejects(() => service.importLocal(exec), /allowlist|unexpected/)
    const linked = mkdtempSync(path.join(tmpdir(), 'skill-link-'))
    mkdirSync(path.join(linked, 'target'))
    symlinkSync(path.join(linked, 'target'), path.join(linked, 'references'))
    writeFileSync(path.join(linked, 'SKILL.md'), '---\nname: linked\ndescription: xxxx\n---\nbody text\n')
    await assert.rejects(() => service.importLocal(linked), /symlink/)
  })

  it('keeps copied bytes stable after the source directory mutates', async () => {
    const service = new SkillService(home(), 'assistant')
    const source = mkdtempSync(path.join(tmpdir(), 'skill-src-'))
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: weekly-review\ndescription: Guide a weekly review.\n---\nUse recall_memory only.\n')
    writeFileSync(path.join(source, 'tars-ng.skill.json'), '{"version":"1.0.0"}\n')
    const imported = await service.importLocal(source)
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: weekly-review\ndescription: mutated\n---\nmutated body here\n')
    assert.equal(service.inspect(imported.candidateId).description, 'Guide a weekly review.')
    await assert.rejects(() => service.importLocal(source), /different bytes/)
  })

  it('uses DSH as the semantic parser for quoted and multiline frontmatter', async () => {
    const service = new SkillService(home(), 'assistant')
    const source = mkdtempSync(path.join(tmpdir(), 'skill-yaml-'))
    writeFileSync(path.join(source, 'SKILL.md'), [
      '---',
      'name: quoted-skill',
      'description: "Guide a weekly review, with commas."',
      'whenToUse: >',
      '  When the user asks for a recap',
      '  or weekly review.',
      'disable-model-invocation: false',
      'user-invocable: true',
      '---',
      'Use existing tools only.',
      '',
    ].join('\n'))
    const imported = await service.importLocal(source)
    const validated = await service.validate(imported.candidateId)
    assert.equal(validated.description, 'Guide a weekly review, with commas.')
    assert.match(validated.whenToUse ?? '', /recap/)
    assert.equal(validated.invocation.modelInvocable, true)
    assert.equal(validated.invocation.userInvocable, true)
  })

  it('requires Recovery Root credentials and Independent Review', async () => {
    const isolated = home()
    const service = new SkillService(isolated, 'assistant')
    const { imported, requested } = await authorApproved(service)
    const forged = new TrustedAuthorityCredential(Symbol('forged'), { kind: 'human-control', source: 'operator-cli' })
    assert.throws(() => service.approve(imported.candidateId, requested.fingerprint, forged), SkillAuthorityError)
    assert.throws(() => service.activate(imported.candidateId, forged), SkillAuthorityError)
    const rootId = Symbol('recovery-root')
    service.bindRoot(rootId)
    const human = humanCred(rootId)
    const approved = service.approve(imported.candidateId, requested.fingerprint, human)
    assert.equal(approved.lifecycle, 'approved')
    assert.equal(service.approvals().length, 1)
    assert.equal(service.approvals()[0]?.authority.source, 'operator-cli')
    assert.equal(service.approvals()[0]?.digest, approved.digest)
    assert.equal(service.catalogNames().length, 0)
    const activated = service.activate(imported.candidateId, human)
    assert.equal(activated.lifecycle, 'active')

    const { ctx, recoveryRoot } = await bootAssistantControl({ home: isolated })
    try {
      assert.equal(typeof (ctx.skillLifecycle as { approve?: unknown }).approve, 'undefined')
      assert.equal(typeof (ctx.skillLifecycle as { activate?: unknown }).activate, 'undefined')
      assert.equal(ctx.tools.get('approve_skill'), undefined)
      assert.equal(ctx.tools.get('activate_skill'), undefined)
      assert.equal(ctx.tools.get('review_skill'), undefined)
      assert.throws(
        () => recoveryRoot.approveSkill(imported.candidateId, requested.fingerprint, forged),
        /credential|authority/i,
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('invalidates the live DSH catalog in the same runtime', async () => {
    const isolated = home()
    const { ctx, recoveryRoot } = await bootAssistantControl({ home: isolated })
    try {
      assert.deepEqual(await ctx.skills.list({ cwd: isolated }), [])
      const imported = await ctx.skillLifecycle.importLocal(FIXTURE)
      await ctx.skillLifecycle.validate(imported.candidateId)
      ctx.skillLifecycle.seal(imported.candidateId)
      ctx.skillLifecycle.requestReview(imported.candidateId, ctx.independentReview)
      const requested = ctx.skillLifecycle.requestApproval(imported.candidateId, ctx.independentReview)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      recoveryRoot.approveSkill(imported.candidateId, requested.fingerprint, human)
      assert.deepEqual(await ctx.skills.list({ cwd: isolated }), [])
      recoveryRoot.activateSkill(imported.candidateId, human)
      const listed = await ctx.skills.list({ cwd: isolated })
      assert.equal(listed.filter((item) => item.name === 'weekly-review').length, 1)
      const loaded = await ctx.skills.get('weekly-review', { cwd: isolated })
      assert.ok(loaded)
      assert.ok(ctx.tools.get('skill'))
      recoveryRoot.disableSkill('weekly-review', human)
      assert.equal((await ctx.skills.list({ cwd: isolated })).some((item) => item.name === 'weekly-review'), false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recovers activate/disable interrupts and fails closed on digest mismatch', async () => {
    const isolated = home()
    const service = new SkillService(isolated, 'assistant')
    const rootId = Symbol('recovery-root')
    service.bindRoot(rootId)
    const human = humanCred(rootId)
    const { imported, requested } = await authorApproved(service)
    service.approve(imported.candidateId, requested.fingerprint, human)
    service.interruptAfter = 'after-incoming'
    assert.throws(() => service.activate(imported.candidateId, human), /after-incoming/)
    const recovered = new SkillService(isolated, 'assistant')
    recovered.bindRoot(rootId)
    assert.equal(recovered.catalogNames().length, 0)
    const activated = recovered.activate(imported.candidateId, human)
    assert.equal(activated.lifecycle, 'active')
    recovered.interruptAfter = 'after-outgoing'
    assert.throws(() => recovered.disable('weekly-review', human), /after-outgoing/)
    const afterDisable = new SkillService(isolated, 'assistant')
    afterDisable.bindRoot(rootId)
    assert.deepEqual(afterDisable.catalogNames(), ['weekly-review'])
    const dest = path.join(isolated, 'self-extension', 'skills', 'assistant', 'active', 'weekly-review', 'SKILL.md')
    writeFileSync(dest, `${readFileSync(dest, 'utf8')}\n# tamper\n`)
    assert.throws(() => new SkillService(isolated, 'assistant'), /digest mismatch/)
  })

  it('withholds skill mutation tools in Safe Mode', async () => {
    const isolated = home()
    const ready = await bootAssistantControl({ home: isolated })
    try {
      assert.ok(ready.ctx.tools.get('plan_skill'))
      assert.ok(ready.ctx.tools.get('request_skill_review'))
    } finally {
      await ready.ctx.fiber.dispose()
    }
    const safe = await bootSafeModeRuntime({ home: isolated })
    try {
      assert.ok(safe.ctx.tools.get('inspect_skill'))
      for (const name of [
        'plan_skill',
        'create_skill_candidate',
        'validate_skill',
        'seal_skill',
        'review_skill',
        'request_skill_review',
        'request_skill_approval',
        'write_skill_file',
      ]) {
        assert.equal(safe.ctx.tools.get(name), undefined, name)
      }
      assert.equal(safe.ctx.tools.get('skill'), undefined)
      assert.ok(SAFE_MODE_TOOL_NAMES.includes('inspect_skill'))
    } finally {
      await safe.ctx.fiber.dispose()
    }
  })

  it('withholds user skills in Safe Mode and does not scan ambient roots', async () => {
    const isolated = home()
    const ambient = mkdtempSync(path.join(tmpdir(), 'ambient-dsh-'))
    mkdirSync(path.join(ambient, 'skills', 'sneaky'), { recursive: true })
    writeFileSync(path.join(ambient, 'skills', 'sneaky', 'SKILL.md'), '---\nname: sneaky\ndescription: should not load\n---\nsecret instruction\n')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = ambient
    try {
      const ready = await bootAssistantControl({ home: isolated })
      try {
        const listed = await ready.ctx.skills.list({ cwd: isolated })
        assert.equal(listed.some((item) => item.name === 'sneaky'), false)
      } finally {
        await ready.ctx.fiber.dispose()
      }
      const safe = await bootSafeModeRuntime({ home: isolated })
      try {
        const listed = await safe.ctx.skills.list({ cwd: isolated })
        assert.equal(listed.some((item) => item.name === 'weekly-review'), false)
        assert.equal(safe.ctx.tools.get('skill'), undefined)
      } finally {
        await safe.ctx.fiber.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
