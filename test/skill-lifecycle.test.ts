import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SkillContractError, SkillService } from '../src/domain/skill/index.js'
import { bootAssistantControl, bootSafeModeRuntime } from '../src/runtime/boot.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/skills/weekly-review', import.meta.url))

function home(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-ng-skill-'))
}

describe('skill lifecycle', () => {
  it('imports a local bundle as an inactive third-party candidate', () => {
    const service = new SkillService(home(), 'assistant')
    const imported = service.importLocal(FIXTURE)
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

  it('rejects traversal, symlink, executable files, and secret metadata', () => {
    const service = new SkillService(home(), 'assistant')
    const bad = mkdtempSync(path.join(tmpdir(), 'skill-bad-'))
    writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: bad\ndescription: x\napi_key: secret\n---\nbody\n')
    assert.throws(() => service.importLocal(bad), SkillContractError)
    const exec = mkdtempSync(path.join(tmpdir(), 'skill-exec-'))
    writeFileSync(path.join(exec, 'SKILL.md'), '---\nname: exec\ndescription: xxxx\n---\nbody text\n')
    writeFileSync(path.join(exec, 'run.sh'), '#!/bin/sh\n')
    assert.throws(() => service.importLocal(exec), /allowlist|unexpected/)
    const linked = mkdtempSync(path.join(tmpdir(), 'skill-link-'))
    mkdirSync(path.join(linked, 'target'))
    symlinkSync(path.join(linked, 'target'), path.join(linked, 'references'))
    writeFileSync(path.join(linked, 'SKILL.md'), '---\nname: linked\ndescription: xxxx\n---\nbody text\n')
    assert.throws(() => service.importLocal(linked), /symlink/)
  })

  it('keeps copied bytes stable after the source directory mutates', () => {
    const service = new SkillService(home(), 'assistant')
    const source = mkdtempSync(path.join(tmpdir(), 'skill-src-'))
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: weekly-review\ndescription: Guide a weekly review.\n---\nUse recall_memory only.\n')
    writeFileSync(path.join(source, 'tars-ng.skill.json'), '{"version":"1.0.0"}\n')
    const imported = service.importLocal(source)
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: weekly-review\ndescription: mutated\n---\nmutated body here\n')
    assert.equal(service.inspect(imported.candidateId).description, 'Guide a weekly review.')
    assert.throws(() => service.importLocal(source), /different bytes/)
  })

  it('approves without activating, then activates into the DSH catalog', async () => {
    const isolated = home()
    const service = new SkillService(isolated, 'assistant')
    const imported = service.importLocal(FIXTURE)
    await service.validate(imported.candidateId)
    const sealed = service.seal(imported.candidateId)
    assert.equal(sealed.sealed, true)
    service.review(imported.candidateId)
    assert.throws(() => service.activate(imported.candidateId), /approval/)
    const requested = service.requestApproval(imported.candidateId)
    const approved = service.approve(imported.candidateId, requested.fingerprint)
    assert.equal(approved.lifecycle, 'approved')
    assert.equal(service.catalogNames().length, 0)
    const activated = service.activate(imported.candidateId)
    assert.equal(activated.lifecycle, 'active')
    assert.deepEqual(service.catalogNames(), ['weekly-review'])

    const { ctx } = await bootAssistantControl({ home: isolated })
    try {
      const listed = await ctx.skills.list({ cwd: isolated })
      assert.ok(listed.some((item) => item.name === 'weekly-review'))
      const loaded = await ctx.skills.get('weekly-review', { cwd: isolated })
      assert.ok(loaded)
      assert.match(loaded!.content, /recall_memory|retrieve_knowledge/)
      assert.equal(ctx.tools.get('approve_skill'), undefined)
      assert.equal(ctx.tools.get('activate_skill'), undefined)
    } finally {
      await ctx.fiber.dispose()
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
