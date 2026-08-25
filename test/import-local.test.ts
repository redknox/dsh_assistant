import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { importLocalExtension, ImportLocalError, CandidateService } from '../src/domain/candidate/index.js'
import { RecoveryRoot } from '../src/domain/governance/index.js'
import { InMemoryRegistryPersistence, RegistryContractError, RegistryService, bootstrapCoreInventory } from '../src/domain/registry/index.js'
import { ResolutionService } from '../src/domain/resolution/index.js'
import { ReviewService } from '../src/domain/review/index.js'
import { WorkbenchService } from '../src/domain/workbench/index.js'
import { gatherWorkspaceSnapshot, projectMissionControl } from '../src/domain/workspace/index.js'
import { operatorStatus } from '../src/domain/self-extension/status.js'
import { ensureProductHome } from '../src/product/home.js'
import { acquireRuntimeLease } from '../src/product/runtime-lease.js'
import { bootAssistantControl } from '../src/runtime/boot.js'
import { runSelfExtensionCli } from '../src/runtime/self-extension-cli.js'

const FIXTURE = path.join(import.meta.dirname, '../fixtures/self-extension/third-party-text-reverse')

async function tool(ctx: { tools: { execute(input: unknown): Promise<{ isError: boolean; value?: unknown }> } }, name: string, args: Record<string, unknown> = {}) {
  return ctx.tools.execute({
    callId: CallId(`import-${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    signal: AbortSignal.timeout(15000),
  })
}

function parse(result: { isError: boolean; value?: unknown }) {
  assert.equal(result.isError, false, String(result.value))
  return JSON.parse(String(result.value)) as Record<string, unknown>
}

function isolatedImport() {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  const workspace = new CandidateService(registry, mkdtempSync(path.join(tmpdir(), 'dsh-import-')))
  const independent = new ReviewService(undefined, (id) => workspace.get(id), { hostLineage: true })
  const root = new RecoveryRoot(registry, workspace, undefined, { independentReview: independent })
  const workbench = new WorkbenchService(
    new ResolutionService(registry),
    workspace,
    workspace,
    independent,
    root.service,
    { registry },
  )
  return { registry, workspace, workbench, root, independent }
}

function writeBundle(dir: string, overrides: { version?: string; extra?: Record<string, unknown>; plugin?: string } = {}) {
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'text-reverse',
    version: overrides.version ?? '1.0.0',
    type: 'module',
    main: 'src/plugin.js',
    tarsNg: { capability: 'text.reverse', tools: ['text_reverse'] },
    ...overrides.extra,
  }, null, 2)}\n`)
  writeFileSync(
    path.join(dir, 'src', 'plugin.js'),
    overrides.plugin ?? `export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'text_reverse',
    description: 'Reverse text',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) { return String(args.text ?? '').split('').reverse().join('') },
  })
  ctx.effect(() => dispose)
}
`,
  )
  return dir
}

describe('local third-party import', () => {
  it('imports a valid local v1 bundle as an inactive third-party candidate', () => {
    const setup = isolatedImport()
    const before = setup.registry.list({ status: 'active' }).map((item) => `${item.owner}@${item.version}`).sort()
    const imported = importLocalExtension({
      sourceDir: FIXTURE,
      workspace: setup.workspace,
      workbench: setup.workbench,
    })
    assert.equal(imported.status, 'imported')
    assert.equal(imported.owner, 'third-party/text-reverse')
    assert.equal(imported.version, '1.0.0')
    assert.deepEqual(imported.provenance, { kind: 'third-party', origin: 'import' })
    assert.equal(imported.sealed, false)
    assert.equal(imported.nextAction, 'validate')
    const record = setup.workspace.get(imported.candidateId)
    assert.equal(record.lifecycle, 'developing')
    assert.equal(record.manifest.runtimeContractVersion, 'generated-extension-api/v1')
    assert.equal(setup.registry.get(record.owner, record.version), undefined)
    assert.deepEqual(
      setup.registry.list({ status: 'active' }).map((item) => `${item.owner}@${item.version}`).sort(),
      before,
    )
    const status = operatorStatus({
      activation: setup.root.inspect(),
      registry: [...setup.registry.list()],
      candidates: [...setup.workspace.list()],
    })
    assert.equal(status.thirdPartyImported, 1)
    assert.equal(status.thirdPartyActive, 0)
  })

  it('ignores bundle provenance claims and host-stamps third-party/import', () => {
    const setup = isolatedImport()
    const dir = writeBundle(mkdtempSync(path.join(tmpdir(), 'claim-')), {
      extra: { provenance: 'dsh-official', owner: 'managed/calendar' },
    })
    const imported = importLocalExtension({ sourceDir: dir, workspace: setup.workspace, workbench: setup.workbench })
    const record = setup.workspace.get(imported.candidateId)
    assert.deepEqual(record.provenance, { kind: 'third-party', origin: 'import' })
    assert.equal(record.owner, 'third-party/text-reverse')
  })

  it('copies bytes so later source mutation does not change the candidate', () => {
    const setup = isolatedImport()
    const dir = writeBundle(mkdtempSync(path.join(tmpdir(), 'mutate-')))
    const imported = importLocalExtension({ sourceDir: dir, workspace: setup.workspace, workbench: setup.workbench })
    const before = setup.workspace.readFile(imported.candidateId, 'src/plugin.js')
    writeFileSync(path.join(dir, 'src', 'plugin.js'), 'export function apply() { throw new Error("mutated") }\n')
    assert.equal(setup.workspace.readFile(imported.candidateId, 'src/plugin.js'), before)
  })

  it('treats exact re-import as duplicate and rejects same owner/version with different bytes', () => {
    const setup = isolatedImport()
    const first = importLocalExtension({ sourceDir: FIXTURE, workspace: setup.workspace, workbench: setup.workbench })
    const again = importLocalExtension({ sourceDir: FIXTURE, workspace: setup.workspace, workbench: setup.workbench })
    assert.equal(again.status, 'duplicate')
    assert.equal(again.candidateId, first.candidateId)
    const other = writeBundle(mkdtempSync(path.join(tmpdir(), 'conflict-')), {
      plugin: 'export function apply(ctx) { ctx.effect(() => {}) }\n',
    })
    assert.throws(
      () => importLocalExtension({ sourceDir: other, workspace: setup.workspace, workbench: setup.workbench }),
      /different bytes/,
    )
    assert.equal(setup.workspace.list().length, 1)
  })

  it('rolls back a failed publication so no partial candidate remains', () => {
    const setup = isolatedImport()
    const workbench = {
      adoptImported() {
        throw new Error('forced publication failure')
      },
    }
    assert.throws(
      () => importLocalExtension({ sourceDir: FIXTURE, workspace: setup.workspace, workbench }),
      ImportLocalError,
    )
    assert.deepEqual(setup.workspace.list(), [])
  })

  it('rejects traversal, symlink, unexpected files, scripts, and every dependency class', () => {
    const setup = isolatedImport()
    const reject = (dir: string, pattern: RegExp) => {
      assert.throws(
        () => importLocalExtension({ sourceDir: dir, workspace: setup.workspace, workbench: setup.workbench }),
        pattern,
      )
    }

    const symlinkDir = mkdtempSync(path.join(tmpdir(), 'sym-'))
    writeBundle(symlinkDir)
    symlinkSync(path.join(symlinkDir, 'src/plugin.js'), path.join(symlinkDir, 'src/link.js'))
    reject(symlinkDir, /symlink/)

    const unexpected = writeBundle(mkdtempSync(path.join(tmpdir(), 'extra-')))
    writeFileSync(path.join(unexpected, 'notes.md'), 'nope\n')
    reject(unexpected, /allowlist/)

    const scripts = writeBundle(mkdtempSync(path.join(tmpdir(), 'scripts-')), {
      extra: { scripts: { postinstall: 'echo pwn' } },
    })
    reject(scripts, /scripts/)

    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dir = writeBundle(mkdtempSync(path.join(tmpdir(), `${field}-`)), {
        extra: { [field]: { leftpad: '1.0.0' } },
      })
      reject(dir, new RegExp(field))
    }

    const secret = writeBundle(mkdtempSync(path.join(tmpdir(), 'secret-')), {
      extra: { apiKey: 'sk-not-a-real-secret' },
    })
    reject(secret, /secret-bearing/)

    const native = writeBundle(mkdtempSync(path.join(tmpdir(), 'native-')))
    writeFileSync(path.join(native, 'src', 'addon.node'), 'nope')
    reject(native, /allowlist|binary/)

    const lock = writeBundle(mkdtempSync(path.join(tmpdir(), 'lock-')))
    writeFileSync(path.join(lock, 'package-lock.json'), '{}\n')
    reject(lock, /unexpected import path/)
    assert.deepEqual(setup.workspace.list(), [])
  })

  it('refuses in-place rewrite and does not expose a model-facing import path', async () => {
    const { ctx } = await bootAssistantControl({ home: mkdtempSync(path.join(tmpdir(), 'tars-ng-import-ro-')) })
    try {
      const imported = importLocalExtension({
        sourceDir: FIXTURE,
        workspace: ctx.candidateWorkspace,
        workbench: ctx.candidateWorkbench,
      })
      assert.throws(
        () => ctx.candidateWorkbench.writeFile(imported.candidateId, 'src/plugin.js', 'nope\n'),
        /read-only/,
      )
      assert.equal(ctx.tools.get('import_local'), undefined)
      assert.equal(ctx.tools.get('import-local'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('validates, reviews, approves, and activates only in the isolated runner', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl({ home: mkdtempSync(path.join(tmpdir(), 'tars-ng-import-life-')) })
    try {
      const imported = importLocalExtension({
        sourceDir: FIXTURE,
        workspace: ctx.candidateWorkspace,
        workbench: ctx.candidateWorkbench,
      })
      assert.equal(ctx.tools.get('text_reverse'), undefined)
      const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'import-b' }))
      const row = view.extensions.find((item) => item.candidateId === imported.candidateId)
      assert.ok(row)
      assert.equal(row.provenance, 'third-party')
      assert.equal(row.provenanceOrigin, 'import')
      assert.ok(view.activity.some((item) => item.summary.includes('Third-party candidate imported')))
      const report = ctx.candidateValidation.validate(imported.candidateId)
      assert.equal(report.passed, true, JSON.stringify(report.stages.filter((item) => item.status !== 'passed' && item.status !== 'not-applicable')))
      parse(await tool(ctx, 'validate_candidate', { candidateId: imported.candidateId }))
      parse(await tool(ctx, 'seal_candidate', { candidateId: imported.candidateId }))
      const reviewed = parse(await tool(ctx, 'review_candidate', { candidateId: imported.candidateId }))
      assert.equal(reviewed.state, 'review-complete')
      const eligibility = ctx.extensionGovernance.requestEligibility(imported.candidateId)
      assert.equal(eligibility.ok, true, JSON.stringify(eligibility.denials))
      const requested = ctx.extensionGovernance.requestApproval(imported.candidateId)
      assert.equal(ctx.tools.get('text_reverse'), undefined)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      recoveryRoot.recordApproval(human, {
        candidateId: imported.candidateId,
        fingerprint: String(requested.fingerprint),
        decision: 'approved-for-exact-diff',
      })
      assert.equal(ctx.tools.get('text_reverse'), undefined)
      const activated = await recoveryRoot.activate(imported.candidateId, human)
      assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics)
      const reversed = await tool(ctx, 'text_reverse', { text: 'abc' })
      assert.equal(String(reversed.value), 'cba')
      const after = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'import-b' }))
      assert.equal(after.extensions.find((item) => item.candidateId === imported.candidateId)?.mounted, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('imports a newer version as an upgrade candidate with a visible diff', () => {
    const setup = isolatedImport()
    importLocalExtension({ sourceDir: FIXTURE, workspace: setup.workspace, workbench: setup.workbench })
    const v2 = writeBundle(mkdtempSync(path.join(tmpdir(), 'v2-')), {
      version: '1.0.1',
      plugin: `export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'text_reverse',
    description: 'Reverse text and mark v2',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) { return \`v2:\${String(args.text ?? '').split('').reverse().join('')}\` },
  })
  ctx.effect(() => dispose)
}
`,
    })
    const imported = importLocalExtension({ sourceDir: v2, workspace: setup.workspace, workbench: setup.workbench })
    assert.equal(imported.version, '1.0.1')
    assert.equal(setup.workspace.list().length, 2)
    const diff = setup.workspace.diff(imported.candidateId)
    assert.equal(diff.candidateVersion, '1.0.1')
  })

  it('rejects third-party registry records that are not origin import', () => {
    const registry = new RegistryService(new InMemoryRegistryPersistence())
    assert.throws(() => registry.register({
      owner: 'third-party/text-reverse',
      version: '1.0.0',
      provenance: { kind: 'third-party', origin: 'assistant' },
      evidence: 'Implemented',
      capabilities: [{ id: 'text.reverse', permissions: [] }],
      runtimeSeams: [],
    }), RegistryContractError)
    assert.throws(() => registry.register({
      owner: 'generated/text-reverse',
      version: '1.0.0',
      provenance: { kind: 'third-party', origin: 'import' },
      evidence: 'Implemented',
      capabilities: [{ id: 'text.reverse', permissions: [] }],
      runtimeSeams: [],
    }), RegistryContractError)
  })
})

describe('import-local CLI lease', () => {
  it('returns home-busy when another verified runtime owns the Home', async () => {
    const previous = process.env.TARS_NG_HOME
    const layout = ensureProductHome(mkdtempSync(path.join(tmpdir(), 'tars-ng-import-busy-')))
    process.env.TARS_NG_HOME = layout.root
    const lease = await acquireRuntimeLease(layout)
    assert.equal(lease.ok, true)
    if (!lease.ok) throw new Error('expected lease')
    const errors: string[] = []
    const original = console.error
    console.error = (text) => {
      errors.push(String(text))
    }
    try {
      const code = await runSelfExtensionCli(['import-local', FIXTURE])
      assert.equal(code, 1)
      assert.match(errors.join('\n'), /home-busy/)
    } finally {
      console.error = original
      lease.hold.release()
      if (previous === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous
    }
  })
})
