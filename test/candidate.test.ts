import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  CandidateService,
  SealedCandidateError,
  WorkspaceEscapeError,
} from '../src/domain/candidate/index.js'
import {
  InMemoryRegistryPersistence,
  RegistryService,
  bootstrapCoreInventory,
} from '../src/domain/registry/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'
import * as candidatePlugin from '../src/plugins/candidate-plugin.js'
import * as registryPlugin from '../src/plugins/registry-plugin.js'

function review(overrides: Partial<ResolutionReview> = {}): ResolutionReview {
  return {
    kind: 'new-plugin',
    capability: 'r0.candidate.probe',
    need: 'independent generated tool',
    recommendation: 'Create a genuinely new candidate plugin.',
    rationale: 'No replaceable owner covers this need.',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability: 'r0.candidate.probe' }, domainOwners: [], conflicts: [] },
    ...overrides,
  }
}

function seeded(area = mkdtempSync(path.join(tmpdir(), 'dsh-cand-'))) {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  return { registry, workspace: new CandidateService(registry, area), area }
}

describe('candidate workspace and validation', () => {
  it('A. evolves an existing owner into a separate candidate workspace', () => {
    const { registry, workspace } = seeded()
    const active = registry.get('managed/integrations', '0.1.0')
    assert.ok(active)
    const before = structuredClone(active)
    const candidate = workspace.create({
      review: review({
        kind: 'evolve-owner',
        capability: 'calendar.read',
        need: 'richer attendee and free-busy filtering',
        target: { owner: 'managed/integrations', version: '0.1.0' },
      }),
      owner: 'managed/integrations',
      version: '0.2.0',
      baseVersion: '0.1.0',
      manifest: {
        capabilities: ['calendar.read', 'calendar.freebusy'],
        runtimeSeams: ['integrations.calendar'],
      },
    })
    workspace.writeFile(candidate.id, 'src/index.ts', 'export const note = "candidate only"\n')
    assert.equal(candidate.owner, 'managed/integrations')
    assert.equal(candidate.version, '0.2.0')
    assert.equal(candidate.manifest.baseVersion, '0.1.0')
    assert.equal(candidate.workspaceRoot.includes('src/plugins'), false)
    assert.deepEqual(registry.get('managed/integrations', '0.1.0'), before)
    assert.equal(registry.resolveActiveOwner('calendar.read').kind, 'owner')
  })

  it('B. creates a generated plugin candidate from a trusted new-plugin review', () => {
    const { workspace, registry } = seeded()
    const candidate = workspace.create({
      review: review({
        kind: 'new-plugin',
        capability: 'matter.light.set',
        need: 'control Matter home devices',
        target: undefined,
      }),
      owner: 'generated/matter-home',
      version: '0.1.0',
      manifest: { capabilities: ['matter.light.set'], runtimeSeams: ['integrations.home'] },
    })
    assert.equal(candidate.provenance.kind, 'generated')
    assert.equal(candidate.provenance.origin, 'assistant')
    assert.equal(candidate.manifest.resolutionKind, 'new-plugin')
    assert.equal(candidate.lifecycle, 'planned')
    assert.equal(registry.resolveActiveOwner('matter.light.set').kind, 'unknown')
    assert.equal(candidate.manifest.resolutionCapability, 'matter.light.set')
  })

  it('C. reports capability and permission expansion without approving it', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.1.0',
      manifest: {
        capabilities: ['r0.candidate.probe', 'calendar.freebusy'],
        permissions: ['local.fake.calendar.freebusy'],
      },
    })
    const diff = workspace.diff(candidate.id)
    assert.deepEqual(diff.capabilities.added, ['r0.candidate.probe', 'calendar.freebusy'])
    assert.deepEqual(diff.permissions.added, ['local.fake.calendar.freebusy'])
    assert.equal(workspace.get(candidate.id).lifecycle, 'planned')
    const report = workspace.validate(candidate.id)
    assert.equal(report.passed, true)
    assert.equal(workspace.get(candidate.id).lifecycle, 'validated')
    assert.equal(workspace.get(candidate.id).manifest.provenance.kind, 'generated')
  })

  it('D. rejects workspace escape attempts', () => {
    const { workspace, area } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    const outside = path.join(area, 'outside.txt')
    assert.throws(() => workspace.writeFile(candidate.id, '../outside.txt', 'no'), WorkspaceEscapeError)
    assert.throws(() => workspace.writeFile(candidate.id, '/tmp/dsh-escape.txt', 'no'), WorkspaceEscapeError)
    assert.throws(() => workspace.link(candidate.id, 'link', '/etc/passwd'), WorkspaceEscapeError)
    assert.equal(existsSync(outside), false)
    assert.equal(existsSync('/tmp/dsh-escape.txt'), false)
  })

  it('E. keeps a failed typecheck from becoming validated', () => {
    const { workspace, registry } = seeded()
    const before = registry.list().length
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'src/bad.ts', 'export const value: string = 1\n')
    const report = workspace.validate(candidate.id)
    assert.equal(report.passed, false)
    assert.equal(workspace.get(candidate.id).lifecycle, 'validation-failed')
    const typecheck = report.stages.find((item) => item.name === 'typecheck')
    assert.equal(typecheck?.status, 'failed')
    assert.ok(typecheck?.diagnostics)
    assert.equal(registry.list().length, before)
  })

  it('F. invalidates validation evidence after a source change', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "ok"\n')
    const first = workspace.validate(candidate.id)
    assert.equal(first.passed, true)
    const digest = first.digest
    workspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "changed"\n')
    const after = workspace.get(candidate.id)
    assert.equal(after.lifecycle, 'developing')
    assert.equal(after.validation, undefined)
    assert.equal(after.digest, undefined)
    const second = workspace.validate(candidate.id)
    assert.notEqual(second.digest, digest)
  })

  it('G. rejects source mutation after seal', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "ok"\n')
    workspace.validate(candidate.id)
    const sealed = workspace.seal(candidate.id)
    assert.equal(sealed.lifecycle, 'validated')
    assert.equal(sealed.sealed, true)
    assert.throws(() => workspace.writeFile(candidate.id, 'src/ok.ts', 'no\n'), SealedCandidateError)
    assert.equal(workspace.readFile(candidate.id, 'src/ok.ts'), 'export const value: string = "ok"\n')
    const failed = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.3.0',
    })
    workspace.writeFile(failed.id, 'src/bad.ts', 'export const value: string = 1\n')
    workspace.validate(failed.id)
    const sealedFailed = workspace.seal(failed.id)
    assert.equal(sealedFailed.lifecycle, 'validation-failed')
    assert.equal(sealedFailed.sealed, true)
  })

  it('H. blocks arbitrary shell and side-effectful install-script requests', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review({
        kind: 'evolve-owner',
        capability: 'r0.script.probe',
        target: { owner: 'managed/r0-script-probe', version: '0.1.0' },
      }),
      owner: 'managed/r0-script-probe',
      version: '0.2.0',
      manifest: {
        validationTasks: [
          { name: 'shell.exec', argv: ['rm', '-rf', '/'] },
          { name: 'npm.script', script: 'postinstall' },
        ],
      },
    })
    workspace.writeFile(candidate.id, 'package.json', JSON.stringify({
      name: 'candidate-integrations',
      scripts: { postinstall: 'node ./install.js' },
    }))
    const report = workspace.validate(candidate.id)
    assert.equal(report.passed, false)
    assert.ok(report.blocked.includes('shell.exec'))
    assert.ok(report.blocked.includes('npm.script:postinstall'))
    const inspect = report.stages.find((item) => item.name === 'package.inspect')
    assert.equal(inspect?.status, 'blocked')
    assert.match(String(inspect?.diagnostics), /postinstall/)
    assert.match(String(inspect?.diagnostics), /"executed":false/)
    assert.equal(workspace.get(candidate.id).lifecycle, 'validation-failed')
  })

  it('does not treat unexecuted candidate tests as a green validation', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "ok"\n')
    workspace.writeFile(candidate.id, 'src/ok.test.ts', 'export const spec = "not executed"\n')
    const report = workspace.validate(candidate.id)
    assert.equal(report.passed, false)
    const tests = report.stages.find((item) => item.name === 'tests')
    assert.equal(tests?.status, 'unresolved')
    assert.equal(workspace.get(candidate.id).lifecycle, 'validation-incomplete')
  })

  it('executes Node-native candidate tests instead of marking them unresolved', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'package.json', `${JSON.stringify({ type: 'module' })}\n`)
    workspace.writeFile(candidate.id, 'src/ok.js', 'export const value = "ok"\n')
    workspace.writeFile(candidate.id, 'src/ok.test.js', `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { value } from './ok.js'
test('runs', () => { assert.equal(value, 'ok') })
`)
    const report = workspace.validate(candidate.id)
    assert.equal(report.passed, true)
    assert.equal(report.stages.find((item) => item.name === 'tests')?.status, 'passed')
    assert.equal(workspace.get(candidate.id).lifecycle, 'validated')
  })

  it('proves the OS sandbox started and denied outbound network', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'package.json', `${JSON.stringify({ type: 'module' })}\n`)
    workspace.writeFile(candidate.id, 'src/network-deny.test.js', `import assert from 'node:assert/strict'
import http2 from 'node:http2'
import { test } from 'node:test'
test('outbound http2 is denied after the sandboxed process starts', async () => {
  const error = await new Promise((resolve, reject) => {
    const client = http2.connect('https://example.com')
    const finish = (err) => {
      try { client.close() } catch {}
      if (err) resolve(err)
      else reject(new Error('http2 connected; OS sandbox did not deny network'))
    }
    client.on('connect', () => finish())
    client.on('error', finish)
  })
  assert.ok(error.code || error.message)
  assert.match(String(error.code ?? error.message), /ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN|EPERM|EACCES|denied|unreachable|refused|not found/i)
})
`)
    const report = workspace.validate(candidate.id)
    assert.equal(report.stages.find((item) => item.name === 'tests')?.status, 'passed', report.stages.find((item) => item.name === 'tests')?.diagnostics)
    assert.equal(report.passed, true)
    assert.equal(workspace.get(candidate.id).lifecycle, 'validated')
  })

  it('does not inherit host secrets or grant host filesystem/network/process authority', () => {
    const previous = process.env.DSH_VALIDATION_SECRET
    process.env.DSH_VALIDATION_SECRET = 's3cret'
    try {
      const outside = mkdtempSync(path.join(tmpdir(), 'validation-outside-'))
      const secretFile = path.join(outside, 'secret.txt')
      writeFileSync(secretFile, 'TOPSECRET\n')
      const { workspace } = seeded()
      const candidate = workspace.create({
        review: review(),
        owner: 'generated/candidate-probe',
        version: '0.2.0',
      })
      workspace.writeFile(candidate.id, 'package.json', `${JSON.stringify({ type: 'module' })}\n`)
      workspace.writeFile(candidate.id, 'src/steal-env.test.js', `import assert from 'node:assert/strict'
import { test } from 'node:test'
test('reads host secret env', () => { assert.equal(process.env.DSH_VALIDATION_SECRET, 's3cret') })
`)
      const envReport = workspace.validate(candidate.id)
      assert.equal(envReport.passed, false)
      assert.equal(envReport.stages.find((item) => item.name === 'tests')?.status, 'failed')

      workspace.writeFile(candidate.id, 'src/steal-env.test.js', 'export const retired = true\n')
      workspace.writeFile(candidate.id, 'src/steal-fs.test.js', `import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
test('reads outside file', () => { assert.equal(readFileSync(${JSON.stringify(secretFile)}, 'utf8'), 'TOPSECRET\\n') })
`)
      const fsReport = workspace.validate(candidate.id)
      assert.equal(fsReport.passed, false)
      assert.equal(fsReport.stages.find((item) => item.name === 'tests')?.status, 'failed')

      workspace.writeFile(candidate.id, 'src/steal-fs.test.js', 'export const retired = true\n')
      workspace.writeFile(candidate.id, 'src/steal-child.test.js', `import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
test('spawns a child', () => {
  const result = spawnSync(process.execPath, ['-e', 'console.log(1)'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
})
`)
      const childReport = workspace.validate(candidate.id)
      assert.equal(childReport.passed, false)
      assert.equal(childReport.stages.find((item) => item.name === 'tests')?.status, 'failed')
    } finally {
      if (previous === undefined) delete process.env.DSH_VALIDATION_SECRET
      else process.env.DSH_VALIDATION_SECRET = previous
    }
  })

  it('fails validation when executed candidate tests fail', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'generated/candidate-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'package.json', `${JSON.stringify({ type: 'module' })}\n`)
    workspace.writeFile(candidate.id, 'src/fail.test.js', `import assert from 'node:assert/strict'
import { test } from 'node:test'
test('fails', () => { assert.equal(1, 2) })
`)
    const report = workspace.validate(candidate.id)
    assert.equal(report.passed, false)
    assert.equal(report.stages.find((item) => item.name === 'tests')?.status, 'failed')
    assert.equal(workspace.get(candidate.id).lifecycle, 'validation-failed')
  })

  it('does not validate a candidate that only declares a postinstall script', () => {
    const { workspace } = seeded()
    const candidate = workspace.create({
      review: review({
        kind: 'evolve-owner',
        capability: 'r0.script.probe',
        target: { owner: 'managed/r0-script-probe', version: '0.1.0' },
      }),
      owner: 'managed/r0-script-probe',
      version: '0.2.0',
    })
    workspace.writeFile(candidate.id, 'package.json', JSON.stringify({
      name: 'candidate-integrations',
      scripts: { postinstall: 'node ./install.js' },
    }))
    const report = workspace.validate(candidate.id)
    assert.equal(report.passed, false)
    const inspect = report.stages.find((item) => item.name === 'package.inspect')
    assert.equal(inspect?.status, 'blocked')
    assert.match(String(inspect?.diagnostics), /"executed":false/)
    assert.equal(workspace.get(candidate.id).lifecycle, 'validation-failed')
  })

  it('I. does not mount a validated candidate into registry or live tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const area = mkdtempSync(path.join(tmpdir(), 'dsh-cand-plugin-'))
    await ctx.plugin(registryPlugin)
    await ctx.plugin(candidatePlugin, { workspaceRoot: area })
    try {
      const ownerBefore = ctx.capabilityRegistry.get('managed/integrations', '0.1.0')
      const candidate = ctx.candidateWorkspace.create({
        review: review({
          kind: 'new-plugin',
          capability: 'r0.candidate.probe',
          need: 'independent generated tool',
          target: undefined,
        }),
        owner: 'generated/candidate-probe',
        version: '0.1.0',
        manifest: { capabilities: ['r0.candidate.probe'] },
      })
      ctx.candidateWorkspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "ok"\n')
      const report = ctx.candidateValidation.validate(candidate.id)
      assert.equal(report.passed, true)
      assert.deepEqual(ctx.capabilityRegistry.get('managed/integrations', '0.1.0'), ownerBefore)
      assert.equal(ctx.capabilityRegistry.resolveActiveOwner('r0.candidate.probe').kind, 'unknown')
      assert.ok(ctx.tools.get('list_capabilities'))
      assert.equal(ctx.tools.get('calendar_freebusy'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

function bootstrapCapabilities(): string[] {
  return [
    'calendar.read',
    'calendar.propose',
    'calendar.execute',
    'mail.read',
    'mail.propose',
    'tasks.read',
    'tasks.propose',
    'tasks.create',
    'files.read',
    'files.write',
    'files.delete',
    'contacts.read',
  ]
}
