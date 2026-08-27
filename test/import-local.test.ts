import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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
  const area = mkdtempSync(path.join(tmpdir(), 'dsh-import-'))
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  const workspace = new CandidateService(registry, area)
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
  return { area, registry, workspace, workbench, root, independent }
}

function importArgs(setup: ReturnType<typeof isolatedImport>, sourceDir: string) {
  return { sourceDir, workspace: setup.workspace, workbench: setup.workbench, registry: setup.registry }
}

async function governAndActivate(
  ctx: Awaited<ReturnType<typeof bootAssistantControl>>['ctx'],
  recoveryRoot: Awaited<ReturnType<typeof bootAssistantControl>>['recoveryRoot'],
  candidateId: string,
): Promise<void> {
  const report = ctx.candidateValidation.validate(candidateId)
  assert.equal(report.passed, true, JSON.stringify(report.stages.filter((item) => item.status !== 'passed' && item.status !== 'not-applicable')))
  ctx.candidateWorkbench.seal(candidateId)
  const reviewed = ctx.candidateWorkbench.review(candidateId)
  assert.equal(reviewed.state, 'review-complete')
  const requested = ctx.extensionGovernance.requestApproval(candidateId)
  const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
  recoveryRoot.recordApproval(human, {
    candidateId,
    fingerprint: String(requested.fingerprint),
    decision: 'approved-for-exact-diff',
  })
  const activated = await recoveryRoot.activate(candidateId, human)
  assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics)
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
    const imported = importLocalExtension(importArgs(setup, FIXTURE))
    assert.equal(imported.status, 'imported')
    assert.equal(imported.owner, 'third-party/text-reverse')
    assert.equal(imported.version, '1.0.0')
    assert.deepEqual(imported.provenance, { kind: 'third-party', origin: 'import' })
    assert.equal(imported.sealed, false)
    assert.equal(imported.nextAction, 'validate')
    const record = setup.workspace.get(imported.candidateId)
    assert.equal(record.lifecycle, 'developing')
    assert.equal(record.baseVersion, undefined)
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
    const imported = importLocalExtension(importArgs(setup, dir))
    const record = setup.workspace.get(imported.candidateId)
    assert.deepEqual(record.provenance, { kind: 'third-party', origin: 'import' })
    assert.equal(record.owner, 'third-party/text-reverse')
  })

  it('copies bytes so later source mutation does not change the candidate', () => {
    const setup = isolatedImport()
    const dir = writeBundle(mkdtempSync(path.join(tmpdir(), 'mutate-')))
    const imported = importLocalExtension(importArgs(setup, dir))
    const before = setup.workspace.readFile(imported.candidateId, 'src/plugin.js')
    writeFileSync(path.join(dir, 'src', 'plugin.js'), 'export function apply() { throw new Error("mutated") }\n')
    assert.equal(setup.workspace.readFile(imported.candidateId, 'src/plugin.js'), before)
  })

  it('treats exact re-import as duplicate and rejects same owner/version with different bytes', () => {
    const setup = isolatedImport()
    const first = importLocalExtension(importArgs(setup, FIXTURE))
    const again = importLocalExtension(importArgs(setup, FIXTURE))
    assert.equal(again.status, 'duplicate')
    assert.equal(again.candidateId, first.candidateId)
    const other = writeBundle(mkdtempSync(path.join(tmpdir(), 'conflict-')), {
      plugin: 'export function apply(ctx) { ctx.effect(() => {}) }\n',
    })
    assert.throws(
      () => importLocalExtension(importArgs(setup, other)),
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
      () => importLocalExtension({ ...importArgs(setup, FIXTURE), workbench }),
      ImportLocalError,
    )
    assert.deepEqual(setup.workspace.list(), [])
  })

  it('does not inherit leftover files after a mid-write import failure', () => {
    const setup = isolatedImport()
    const first = writeBundle(mkdtempSync(path.join(tmpdir(), 'partial-')))
    writeFileSync(path.join(first, 'src', 'leftover.js'), 'export const leftover = true\n')
    assert.throws(
      () => importLocalExtension({
        ...importArgs(setup, first),
        inject: { failAfterWriting: 'src/leftover.js' },
      }),
      /injected failure/,
    )
    const dest = path.join(setup.area, 'third-party--text-reverse@1.0.0')
    assert.equal(existsSync(dest), false)
    assert.equal(existsSync(path.join(setup.area, '.import-staging', 'third-party--text-reverse@1.0.0')), false)
    assert.deepEqual(setup.workspace.list(), [])

    const retry = writeBundle(mkdtempSync(path.join(tmpdir(), 'retry-')))
    const imported = importLocalExtension(importArgs(setup, retry))
    assert.equal(imported.status, 'imported')
    assert.equal(setup.workspace.listFiles(imported.candidateId).includes('src/leftover.js'), false)
    assert.deepEqual(
      setup.workspace.listFiles(imported.candidateId).filter((item) => item.startsWith('src/')),
      ['src/plugin.js'],
    )
  })

  it('rejects traversal, symlink, unexpected files, scripts, and every dependency class', () => {
    const setup = isolatedImport()
    const reject = (dir: string, pattern: RegExp) => {
      assert.throws(
        () => importLocalExtension(importArgs(setup, dir)),
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
        registry: ctx.capabilityRegistry,
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

  it('inspects an unsealed imported candidate without a fingerprint', () => {
    const setup = isolatedImport()
    const imported = importLocalExtension(importArgs(setup, FIXTURE))
    const summary = setup.root.service.inspectSummary(imported.candidateId)
    assert.equal(summary.owner, 'third-party/text-reverse')
    assert.equal(summary.candidateVersion, '1.0.0')
    assert.equal(summary.lifecycle, 'developing')
    assert.equal(summary.sealed, false)
    assert.equal(summary.digest, '')
    assert.equal(summary.validationPassed, false)
    assert.equal('fingerprint' in summary, false)
    assert.ok(summary.tools.added.includes('text_reverse'))
    assert.equal(setup.root.service.inspectApproval(imported.candidateId), undefined)
    assert.throws(() => setup.root.service.requestApproval(imported.candidateId), /not-sealed|not-validated|review-required/)
    assert.equal(setup.root.service.inspectApproval(imported.candidateId), undefined)
  })

  it('inspects imported validate-then-seal states without a fingerprint', () => {
    const setup = isolatedImport()
    const imported = importLocalExtension(importArgs(setup, FIXTURE))
    const report = setup.workspace.validate(imported.candidateId)
    assert.equal(report.passed, true, JSON.stringify(report.stages.filter((item) => item.status !== 'passed' && item.status !== 'not-applicable')))
    const afterValidate = setup.root.service.inspectSummary(imported.candidateId)
    assert.equal(afterValidate.lifecycle, 'validated')
    assert.equal(afterValidate.validationPassed, true)
    assert.equal(afterValidate.sealed, false)
    assert.ok((afterValidate.digest ?? '').length > 0)
    assert.equal('fingerprint' in afterValidate, false)
    assert.throws(() => setup.root.service.requestApproval(imported.candidateId), /not-sealed/)
    const sealed = setup.workspace.seal(imported.candidateId)
    const afterSeal = setup.root.service.inspectSummary(sealed.id)
    assert.equal(afterSeal.sealed, true)
    assert.equal(afterSeal.validationPassed, true)
    assert.equal('fingerprint' in afterSeal, false)
    assert.throws(() => setup.root.service.requestApproval(sealed.id), /review-required/)
    assert.equal(setup.root.service.inspectApproval(sealed.id), undefined)
  })

  it('validates, reviews, approves, and activates only in the isolated runner', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl({ home: mkdtempSync(path.join(tmpdir(), 'tars-ng-import-life-')) })
    try {
      const imported = importLocalExtension({
        sourceDir: FIXTURE,
        workspace: ctx.candidateWorkspace,
        workbench: ctx.candidateWorkbench,
        registry: ctx.capabilityRegistry,
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

  it('disables an imported plugin by unmounting it, then keeps that state across restart', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'tars-ng-import-disable-'))
    const { ctx, recoveryRoot } = await bootAssistantControl({ home })
    try {
      const imported = importLocalExtension({
        sourceDir: FIXTURE,
        workspace: ctx.candidateWorkspace,
        workbench: ctx.candidateWorkbench,
        registry: ctx.capabilityRegistry,
      })
      await governAndActivate(ctx, recoveryRoot, imported.candidateId)
      assert.ok(ctx.tools.get('text_reverse'))
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      await recoveryRoot.disable(human, 'third-party/text-reverse', '1.0.0')
      assert.equal(ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status, 'disabled')
      assert.equal(ctx.tools.get('text_reverse'), undefined)
      const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'import-disable' }))
      assert.equal(view.plugins.some((item) => item.owner === 'third-party/text-reverse'), false)
      const row = view.extensions.find((item) => item.candidateId === imported.candidateId)
      assert.equal(row?.lifecycle, 'DISABLED_REACTIVATABLE')
      assert.equal(row?.mounted, false)
    } finally {
      await ctx.fiber.dispose()
    }
    const restarted = await bootAssistantControl({ home })
    try {
      assert.equal(restarted.ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status, 'disabled')
      assert.equal(restarted.ctx.tools.get('text_reverse'), undefined)
      const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx: restarted.ctx, sessionId: 'import-disable' }))
      assert.equal(view.plugins.some((item) => item.owner === 'third-party/text-reverse'), false)
      const row = view.extensions.find((item) => item.candidateId === 'third-party--text-reverse@1.0.0')
      assert.equal(row?.lifecycle, 'DISABLED_REACTIVATABLE')
      assert.equal(row?.mounted, false)
    } finally {
      await restarted.ctx.fiber.dispose()
    }
  })

  it('binds an upgrade candidate to the active version and rolls back to it', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl({ home: mkdtempSync(path.join(tmpdir(), 'tars-ng-import-upgrade-')) })
    try {
      const first = importLocalExtension({
        sourceDir: FIXTURE,
        workspace: ctx.candidateWorkspace,
        workbench: ctx.candidateWorkbench,
        registry: ctx.capabilityRegistry,
      })
      await governAndActivate(ctx, recoveryRoot, first.candidateId)
      assert.equal(ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status, 'active')

      const v2 = writeBundle(mkdtempSync(path.join(tmpdir(), 'v2-')), {
        version: '1.0.1',
        extra: { tarsNg: { capability: 'text.reverse', tools: ['text_reverse', 'text_mark'] } },
        plugin: `export function apply(ctx) {
  const disposeReverse = ctx.tools.register({
    name: 'text_reverse',
    description: 'Reverse text',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) { return String(args.text ?? '').split('').reverse().join('') },
  })
  const disposeMark = ctx.tools.register({
    name: 'text_mark',
    description: 'Mark text as v2',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) { return \`v2:\${String(args.text ?? '')}\` },
  })
  ctx.effect(() => { disposeReverse(); disposeMark() })
}
`,
      })
      const upgrade = importLocalExtension({
        sourceDir: v2,
        workspace: ctx.candidateWorkspace,
        workbench: ctx.candidateWorkbench,
        registry: ctx.capabilityRegistry,
      })
      const record = ctx.candidateWorkspace.get(upgrade.candidateId)
      assert.equal(record.version, '1.0.1')
      assert.equal(record.baseVersion, '1.0.0')
      assert.equal(record.manifest.baseVersion, '1.0.0')
      const diff = ctx.candidateWorkspace.diff(upgrade.candidateId)
      assert.equal(diff.baseVersion, '1.0.0')
      assert.deepEqual(diff.capabilities.added, [])
      assert.deepEqual(diff.tools.added, ['text_mark'])
      assert.deepEqual(diff.tools.removed, [])

      const report = ctx.candidateValidation.validate(upgrade.candidateId)
      assert.equal(report.passed, true, JSON.stringify(report.stages.filter((item) => item.status !== 'passed' && item.status !== 'not-applicable')))
      ctx.candidateWorkbench.seal(upgrade.candidateId)
      ctx.candidateWorkbench.review(upgrade.candidateId)
      const requested = ctx.extensionGovernance.requestApproval(upgrade.candidateId)
      const summary = ctx.extensionGovernance.inspectSummary(upgrade.candidateId)
      assert.equal(summary.currentVersion, '1.0.0')
      assert.equal(summary.candidateVersion, '1.0.1')
      assert.deepEqual(summary.capabilities.added, [])
      assert.deepEqual(summary.tools.added, ['text_mark'])
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      recoveryRoot.recordApproval(human, {
        candidateId: upgrade.candidateId,
        fingerprint: String(requested.fingerprint),
        decision: 'approved-for-exact-diff',
      })
      const activated = await recoveryRoot.activate(upgrade.candidateId, human)
      assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics)
      assert.equal(ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status, 'disabled')
      assert.equal(ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.1')?.status, 'active')
      const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'import-upgrade' }))
      assert.equal(view.extensions.find((item) => item.candidateId === first.candidateId)?.lifecycle, 'SUPERSEDED')
      const rolled = await recoveryRoot.rollback(human)
      assert.equal(rolled.state, 'rolled-back')
      assert.equal(ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status, 'active')
      assert.equal(ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.1')?.status, 'disabled')
    } finally {
      await ctx.fiber.dispose()
    }
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

describe('import-local CLI inspect', () => {
  it('inspects imported and generated developing candidates then refuses request-approval', async () => {
    const previous = process.env.TARS_NG_HOME
    const home = mkdtempSync(path.join(tmpdir(), 'tars-ng-import-inspect-'))
    process.env.TARS_NG_HOME = home
    const logs: string[] = []
    const errors: string[] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (text) => {
      logs.push(String(text))
    }
    console.error = (text) => {
      errors.push(String(text))
    }
    try {
      const importedCode = await runSelfExtensionCli(['import-local', FIXTURE])
      assert.equal(importedCode, 0)
      logs.length = 0
      const inspectImported = await runSelfExtensionCli(['inspect', 'third-party--text-reverse@1.0.0'])
      assert.equal(inspectImported, 0, errors.join('\n'))
      const importedSummary = JSON.parse(logs.join('\n')) as {
        digest?: string
        validationPassed?: boolean
        fingerprint?: string
        lifecycle?: string
        sealed?: boolean
      }
      assert.equal(importedSummary.lifecycle, 'developing')
      assert.equal(importedSummary.sealed, false)
      assert.equal(importedSummary.digest, '')
      assert.equal(importedSummary.validationPassed, false)
      assert.equal(importedSummary.fingerprint, undefined)
      assert.doesNotMatch(logs.join('\n'), /fingerprint/)
      logs.length = 0
      errors.length = 0
      const requestImported = await runSelfExtensionCli(['request-approval', 'third-party--text-reverse@1.0.0'])
      assert.equal(requestImported, 1)
      assert.match(errors.join('\n'), /not-sealed|not-validated|review-required/)
      assert.doesNotMatch(errors.join('\n'), /at |Error: candidate digest|\/Users\/|src\/plugin/)

      logs.length = 0
      errors.length = 0
      const inspectValidated = await runSelfExtensionCli(['inspect', 'third-party--text-reverse@1.0.0'], {
        boot: async () => {
          const control = await bootAssistantControl({ home })
          const report = control.ctx.candidateValidation.validate('third-party--text-reverse@1.0.0')
          assert.equal(report.passed, true)
          return control
        },
      })
      assert.equal(inspectValidated, 0, errors.join('\n'))
      const validatedSummary = JSON.parse(logs.join('\n')) as { validationPassed?: boolean; sealed?: boolean; fingerprint?: string }
      assert.equal(validatedSummary.validationPassed, true)
      assert.equal(validatedSummary.sealed, false)
      assert.equal(validatedSummary.fingerprint, undefined)
      logs.length = 0
      errors.length = 0
      const requestValidated = await runSelfExtensionCli(['request-approval', 'third-party--text-reverse@1.0.0'])
      assert.equal(requestValidated, 1)
      assert.match(errors.join('\n'), /not-sealed/)

      logs.length = 0
      errors.length = 0
      const inspectSealed = await runSelfExtensionCli(['inspect', 'third-party--text-reverse@1.0.0'], {
        boot: async () => {
          const control = await bootAssistantControl({ home })
          control.ctx.candidateWorkspace.seal('third-party--text-reverse@1.0.0')
          return control
        },
      })
      assert.equal(inspectSealed, 0, errors.join('\n'))
      const sealedSummary = JSON.parse(logs.join('\n')) as { sealed?: boolean; fingerprint?: string }
      assert.equal(sealedSummary.sealed, true)
      assert.equal(sealedSummary.fingerprint, undefined)
      logs.length = 0
      errors.length = 0
      const requestSealed = await runSelfExtensionCli(['request-approval', 'third-party--text-reverse@1.0.0'])
      assert.equal(requestSealed, 1)
      assert.match(errors.join('\n'), /review-required/)

      const generatedId = 'generated--inspect-pending@0.1.0'
      logs.length = 0
      errors.length = 0
      const inspectGenerated = await runSelfExtensionCli(['inspect', generatedId], {
        boot: async () => {
          const control = await bootAssistantControl({ home })
          control.ctx.candidateWorkspace.create({
            review: {
              kind: 'new-plugin',
              capability: 'text.inspect',
              need: 'inspect',
              recommendation: 'create',
              rationale: 'test',
              implications: [],
              assumptions: [],
              unresolved: [],
              steps: [],
              registryFacts: { exact: { kind: 'unknown', capability: 'text.inspect' }, domainOwners: [], conflicts: [] },
            },
            owner: 'generated/inspect-pending',
            version: '0.1.0',
            manifest: { capabilities: ['text.inspect'], permissions: [], runtimeSeams: [], tools: [] },
          })
          return control
        },
      })
      assert.equal(inspectGenerated, 0, errors.join('\n'))
      const generatedSummary = JSON.parse(logs.join('\n')) as {
        owner?: string
        digest?: string
        validationPassed?: boolean
        fingerprint?: string
        lifecycle?: string
        sealed?: boolean
      }
      assert.equal(generatedSummary.owner, 'generated/inspect-pending')
      assert.equal(generatedSummary.lifecycle, 'planned')
      assert.equal(generatedSummary.sealed, false)
      assert.equal(generatedSummary.digest, '')
      assert.equal(generatedSummary.validationPassed, false)
      assert.equal(generatedSummary.fingerprint, undefined)
      logs.length = 0
      errors.length = 0
      const requestGenerated = await runSelfExtensionCli(['request-approval', generatedId], {
        boot: async () => bootAssistantControl({ home }),
      })
      assert.equal(requestGenerated, 1)
      assert.match(errors.join('\n'), /not-sealed|not-validated|review-required|unknown-candidate/)
      assert.doesNotMatch(errors.join('\n'), /at |candidate digest is required/)
    } finally {
      console.log = originalLog
      console.error = originalError
      if (previous === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous
    }
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
