import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ReviewService } from '../src/domain/review/index.js'
import { TrustedAuthorityCredential } from '../src/domain/governance/types.js'
import { backupSelfExtension, formatOperatorStatus, operatorStatus, PersistenceIntegrityError, restoreSelfExtension } from '../src/domain/self-extension/index.js'
import { SkillAuthorityError, SkillContractError, SkillService, nextSkillVersion } from '../src/domain/skill/index.js'
import { SAFE_MODE_TOOL_NAMES } from '../src/product/bundle.js'
import { bootAssistantControl, bootSafeModeRuntime } from '../src/runtime/boot.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/skills/weekly-review', import.meta.url))

function home(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-ng-skill-'))
}

function humanCred(rootId: symbol) {
  return new TrustedAuthorityCredential(rootId, { kind: 'human-control', source: 'operator-cli' })
}

function bindHostReview(service: SkillService) {
  service.bindReview(new ReviewService())
}

async function authorApproved(service: SkillService, source = FIXTURE) {
  bindHostReview(service)
  const imported = await service.importLocal(source)
  await service.validate(imported.candidateId)
  service.seal(imported.candidateId)
  const reviewed = service.requestReview(imported.candidateId)
  assert.equal(reviewed.report.state, 'review-complete')
  const requested = service.requestApproval(imported.candidateId)
  return { imported, requested }
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
      assert.equal(ctx.skillLifecycle.requestReview.length, 1)
      assert.equal(ctx.skillLifecycle.requestApproval.length, 1)
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
      ctx.skillLifecycle.requestReview(imported.candidateId)
      const requested = ctx.skillLifecycle.requestApproval(imported.candidateId)
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

  it('rejects a caller-supplied Independent Review stand-in', async () => {
    const isolated = home()
    const service = new SkillService(isolated, 'assistant')
    const imported = await service.importLocal(FIXTURE)
    await service.validate(imported.candidateId)
    service.seal(imported.candidateId)
    const fake = {
      review: () => ({
        candidateId: imported.candidateId,
        digest: service.inspect(imported.candidateId).digest,
        policyVersion: 'm4.1',
        riskClass: 'R0',
        state: 'review-complete',
        findings: [],
        approvalStatus: 'NOT APPROVED',
        summary: 'forged',
      }),
      reviewCandidate: () => { throw new Error('unused') },
      status: () => 'review-complete',
      lastReport: () => undefined,
    }
    assert.throws(() => service.requestReview(imported.candidateId), SkillAuthorityError)
    assert.throws(() => (service as unknown as { requestReview: (id: string, review: unknown) => void })
      .requestReview(imported.candidateId, fake), SkillAuthorityError)
    assert.equal(service.inspect(imported.candidateId).reviewComplete, false)
    assert.throws(() => (service as unknown as { requestApproval: (id: string, review: unknown) => void })
      .requestApproval(imported.candidateId, fake), /independent review is required/)

    const { ctx } = await bootAssistantControl({ home: isolated })
    try {
      assert.throws(() => (
        ctx.skillLifecycle as unknown as { requestApproval: (id: string, review: unknown) => void }
      ).requestApproval(imported.candidateId, fake), /independent review is required/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('allocates skill versions by numeric semver and forks active edits', async () => {
    assert.equal(nextSkillVersion(['1.0.9', '1.0.10']), '1.0.11')
    assert.equal(nextSkillVersion(['1.0.99', '1.1.0']), '1.1.1')
    const service = new SkillService(home(), 'assistant')
    const versions: string[] = []
    for (let i = 0; i < 12; i += 1) {
      versions.push(service.create({
        name: 'version-bump',
        description: 'Allocate the next host skill version.',
        body: 'Keep this instruction body long enough.',
      }).version)
    }
    assert.deepEqual(versions.slice(-3), ['1.0.9', '1.0.10', '1.0.11'])
    assert.doesNotThrow(() => service.create({
      name: 'version-bump',
      description: 'Allocate the next host skill version.',
      body: 'Keep this instruction body long enough.',
    }))

    const isolated = home()
    const live = new SkillService(isolated, 'assistant')
    const rootId = Symbol('recovery-root')
    live.bindRoot(rootId)
    const { imported, requested } = await authorApproved(live)
    live.approve(imported.candidateId, requested.fingerprint, humanCred(rootId))
    live.activate(imported.candidateId, humanCred(rootId))
    const forked = live.writeFile(imported.candidateId, 'SKILL.md', [
      '---',
      'name: weekly-review',
      'description: Guide a weekly review using existing memory and knowledge tools.',
      '---',
      'Use existing tools only. This is a new revision.',
      '',
    ].join('\n'))
    assert.notEqual(forked.id, imported.candidateId)
    assert.equal(forked.lifecycle, 'drafted')
    assert.equal(forked.sealed, false)
    assert.equal(forked.baseVersion, '1.0.0')
    assert.equal(live.get(imported.candidateId).lifecycle, 'active')
  })

  it('blocks uninstall only for host-owned hard dependents', async () => {
    const isolated = home()
    const service = new SkillService(isolated, 'assistant')
    const rootId = Symbol('recovery-root')
    service.bindRoot(rootId)
    const human = humanCred(rootId)
    const { imported, requested } = await authorApproved(service)
    service.approve(imported.candidateId, requested.fingerprint, human)
    const prose = service.create({
      name: 'mentions-weekly',
      description: 'Talk about weekly-review in prose only.',
      body: 'This text mentions weekly-review but does not depend on it.',
    })
    assert.equal(prose.dependsOn.length, 0)
    service.uninstall('weekly-review', human)
    assert.equal(service.get(imported.candidateId).lifecycle, 'uninstalled')

    const again = new SkillService(home(), 'assistant')
    again.bindRoot(rootId)
    const second = await authorApproved(again)
    again.approve(second.imported.candidateId, second.requested.fingerprint, human)
    const dependent = again.create({
      name: 'needs-weekly',
      description: 'Host-declared hard dependent of weekly-review.',
      body: 'This skill needs the exact weekly-review revision.',
      dependsOn: [{ name: 'weekly-review', version: '1.0.0' }],
    })
    assert.throws(() => again.uninstall('weekly-review', human), /hard dependents/)
    assert.throws(() => again.uninstall('weekly-review', human, [prose.id]), /hard dependents/)
    again.uninstall('weekly-review', human, [dependent.id])
    assert.equal(again.get(second.imported.candidateId).lifecycle, 'uninstalled')
  })

  it('isolates Skill stores by Home and Profile', async () => {
    const firstHome = home()
    const secondHome = home()
    const assistant = new SkillService(firstHome, 'assistant')
    const otherProfile = new SkillService(firstHome, 'other')
    const otherHome = new SkillService(secondHome, 'assistant')
    const imported = await assistant.importLocal(FIXTURE)
    assert.equal(otherProfile.list().some((item) => item.id === imported.candidateId), false)
    assert.equal(otherHome.list().some((item) => item.id === imported.candidateId), false)
    assert.equal(assistant.list().some((item) => item.id === imported.candidateId), true)
  })

  it('refuses to disable or uninstall a system Skill', async () => {
    const isolated = home()
    const service = new SkillService(isolated, 'assistant')
    const rootId = Symbol('recovery-root')
    service.bindRoot(rootId)
    const human = humanCred(rootId)
    const drafted = service.installSystem({
      name: 'system-brief',
      description: 'Host-owned system briefing skill.',
      body: 'Use recall_memory only for this system brief.',
    })
    bindHostReview(service)
    await service.validate(drafted.id)
    service.seal(drafted.id)
    service.requestReview(drafted.id)
    const requested = service.requestApproval(drafted.id)
    service.approve(drafted.id, requested.fingerprint, human)
    service.activate(drafted.id, human)
    assert.throws(() => service.disable('system-brief', human), /cannot be disabled or uninstalled/)
    assert.throws(() => service.uninstall('system-brief', human), /cannot be disabled or uninstalled/)
    assert.equal(service.get(drafted.id).lifecycle, 'active')
  })

  it('diffs v1 to v2 without leaking instruction body', async () => {
    const isolated = home()
    const service = new SkillService(isolated, 'assistant')
    const rootId = Symbol('recovery-root')
    service.bindRoot(rootId)
    const { imported, requested } = await authorApproved(service)
    service.approve(imported.candidateId, requested.fingerprint, humanCred(rootId))
    service.activate(imported.candidateId, humanCred(rootId))
    const before = service.readFile(imported.candidateId, 'SKILL.md')
    const forked = service.writeFile(imported.candidateId, 'SKILL.md', [
      '---',
      'name: weekly-review',
      'description: Guide a weekly review using existing memory and knowledge tools.',
      '---',
      'Use existing tools only. This is an exact v2 instruction body.',
      '',
    ].join('\n'))
    await service.validate(forked.id)
    const diff = service.diff(forked.id)
    assert.equal(diff.from?.version, '1.0.0')
    assert.equal(diff.to.version, '1.0.1')
    assert.equal(diff.instructionChanged, true)
    assert.ok(diff.instructionBeforeChars > 0)
    assert.ok(diff.instructionAfterChars > 0)
    assert.doesNotMatch(JSON.stringify(diff), /exact v2 instruction body/)
    service.disable('weekly-review', humanCred(rootId))
    assert.equal(service.readFile(imported.candidateId, 'SKILL.md'), before)
    assert.equal(service.get(imported.candidateId).lifecycle, 'disabled')
  })

  it('hands missing tools to Capability Resolution and does not invent authority', async () => {
    const unbound = new SkillService(home(), 'assistant')
    const imported = await unbound.importLocal(FIXTURE)
    await unbound.validate(imported.candidateId)
    assert.equal(unbound.inspect(imported.candidateId).resolutionHandoff, undefined)

    const service = new SkillService(home(), 'assistant')
    service.bindKnownTools(() => ['recall_memory'])
    const drafted = service.create({
      name: 'needs-resolution',
      description: 'Mentions a tool that is not in inventory.',
      body: 'Call `missing_calendar_tool` then `recall_memory` if needed.',
    })
    await service.validate(drafted.id)
    assert.deepEqual(service.inspect(drafted.id).resolutionHandoff, {
      missingTools: ['missing_calendar_tool'],
      nextAction: 'capability-resolution',
    })
  })

  it('backs up and restores Skills and fails closed on a tampered active digest', async () => {
    const isolated = home()
    const ready = await bootAssistantControl({ home: isolated })
    try {
      const service = ready.ctx.skillLifecycle
      const imported = await service.importLocal(FIXTURE)
      await service.validate(imported.candidateId)
      service.seal(imported.candidateId)
      service.requestReview(imported.candidateId)
      const requested = service.requestApproval(imported.candidateId)
      const human = ready.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      ready.recoveryRoot.approveSkill(imported.candidateId, requested.fingerprint, human)
      ready.recoveryRoot.activateSkill(imported.candidateId, human)
      const dest = mkdtempSync(path.join(tmpdir(), 'skill-bak-'))
      const tampered = mkdtempSync(path.join(tmpdir(), 'skill-bak-bad-'))
      backupSelfExtension(isolated, dest)
      assert.ok(service.health().active.includes(imported.candidateId))
      const status = formatOperatorStatus(operatorStatus({
        activation: ready.recoveryRoot.inspect(),
        registry: [...ready.ctx.capabilityRegistry.list()],
        candidates: [...ready.ctx.candidateWorkspace.list()],
        skills: service.health(),
      }))
      assert.match(status, /skills: profile=assistant catalog=ok/)
      cpSync(dest, tampered, { recursive: true })
      writeFileSync(
        path.join(tampered, 'skills', 'assistant', 'active', 'weekly-review', 'SKILL.md'),
        '---\nname: weekly-review\ndescription: tampered\n---\ntampered body\n',
      )
      assert.throws(() => restoreSelfExtension(tampered, home()), PersistenceIntegrityError)
      const restoredHome = home()
      const empty = await bootAssistantControl({ home: restoredHome })
      try {
        restoreSelfExtension(dest, restoredHome)
      } finally {
        await empty.ctx.fiber.dispose()
      }
      const restored = new SkillService(restoredHome, 'assistant')
      assert.equal(restored.get(imported.candidateId).lifecycle, 'active')
    } finally {
      await ready.ctx.fiber.dispose()
    }
  })
})
