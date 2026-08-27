import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parse } from 'acorn'
import { contractDigestExtras, digestFiles } from './digest.js'
import { listSourceFiles } from './files.js'
import { detectOsNetworkSandbox } from './os-sandbox.js'
import { runRestrictedCandidateTests, runnerUnavailable } from './restricted-runner.js'
import { evaluateActivationCompatibility } from '../activation-compatibility/index.js'
import { evaluateReliability, reliabilitySummary } from '../reliability/index.js'
import { normalizeRegisterInput } from '../registry/normalize.js'
import { assertGeneratedBrokerPermissions } from '../generated-runtime/broker.js'
import type { OwnerExecutionFacts } from '../activation-compatibility/index.js'
import type { CandidateRecord, ValidationReport, ValidationStageResult, ValidationStageStatus } from './types.js'
import { ALLOWED_VALIDATION_TASKS } from './types.js'

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare']
const FORBIDDEN_IMPORT = /@deepseek-ai\/dsh[^"'\\n]*\/src\//

function stage(
  name: string,
  status: ValidationStageStatus,
  summary: string,
  extra: Partial<ValidationStageResult> = {},
): ValidationStageResult {
  const now = new Date().toISOString()
  return {
    name,
    status,
    summary,
    startedAt: now,
    endedAt: now,
    evidence: status === 'passed' ? 'Verified' : status === 'not-applicable' ? 'Unknown' : 'Implemented',
    ...extra,
  }
}

function inspectPackage(root: string, generatedV1: boolean): ValidationStageResult {
  const pkgPath = path.join(root, 'package.json')
  if (!existsSync(pkgPath)) {
    return stage('package.inspect', 'not-applicable', 'No package.json in the candidate workspace.')
  }
  const raw = readFileSync(pkgPath, 'utf8')
  let parsed: {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return stage('package.inspect', 'failed', 'package.json is not valid JSON.', { diagnostics: raw.slice(0, 500) })
  }
  const scripts = parsed.scripts ?? {}
  const lifecycle = Object.keys(scripts).filter((name) => LIFECYCLE_SCRIPTS.includes(name))
  const deps = {
    ...parsed.dependencies,
    ...parsed.devDependencies,
    ...parsed.optionalDependencies,
    ...parsed.peerDependencies,
  }
  const diagnostics = JSON.stringify({
    dependencies: Object.keys(deps),
    lifecycleScripts: lifecycle.map((name) => ({ name, command: scripts[name], executed: false, risk: 'blocked' })),
  })
  if (generatedV1 && (Object.keys(scripts).length > 0 || Object.keys(deps).length > 0)) {
    return stage(
      'package.inspect',
      'failed',
      'generated-extension-api/v1 forbids package scripts and dependencies.',
      { diagnostics },
    )
  }
  if (lifecycle.length > 0) {
    return stage(
      'package.inspect',
      'blocked',
      `Install lifecycle scripts ${lifecycle.join(', ')} were not executed and block validation until later policy handles them.`,
      { diagnostics },
    )
  }
  return stage(
    'package.inspect',
    'passed',
    `Inspected ${Object.keys(deps).length} declared dependencies; no install lifecycle scripts.`,
    { diagnostics },
  )
}

function inspectActivationCompatibility(
  record: CandidateRecord,
  activeOwner?: OwnerExecutionFacts,
): ValidationStageResult {
  const result = evaluateActivationCompatibility({
    owner: record.owner,
    provenanceKind: record.provenance.kind,
    origin: record.provenance.origin,
    resolutionKind: record.manifest.resolutionKind,
    resolutionCapability: record.manifest.resolutionCapability,
    capabilities: record.manifest.capabilities,
    services: record.manifest.services,
    providers: record.manifest.providers,
    runtimeContractVersion: record.manifest.runtimeContractVersion,
    activeOwner,
  })
  if (result.ok) {
    return stage('activation.compatibility', 'passed', 'Candidate is structurally eligible for its execution contract.')
  }
  return stage(
    'activation.compatibility',
    'failed',
    result.denials.map((item) => item.reason).join('; '),
    { diagnostics: result.denials.map((item) => `${item.reason}: ${item.detail}`).join('; ') },
  )
}

function inspectRuntimeContract(record: CandidateRecord): ValidationStageResult {
  const generated = record.provenance.kind === 'generated'
    || record.provenance.kind === 'third-party'
    || record.owner.startsWith('generated/')
    || record.owner.startsWith('third-party/')
  const version = record.manifest.runtimeContractVersion
  if (generated) {
    if (version !== 'generated-extension-api/v1') {
      return stage(
        'runtime.contract',
        'failed',
        version === undefined
          ? 'Generated candidate is missing a host-owned authoring contract version.'
          : `Unsupported authoring contract ${version}.`,
        { diagnostics: 'unsupported-or-missing-contract-version' },
      )
    }
    try {
      assertGeneratedBrokerPermissions(record.manifest.permissions)
    } catch (error) {
      return stage(
        'runtime.contract',
        'failed',
        error instanceof Error ? error.message : 'Generated Broker permissions are unsupported.',
      )
    }
    return stage('runtime.contract', 'passed', 'Host authoring contract generated-extension-api/v1.')
  }
  if (version !== undefined && version !== 'generated-extension-api/v1') {
    return stage('runtime.contract', 'failed', `Unsupported authoring contract ${version}.`, {
      diagnostics: 'unsupported-contract-version',
    })
  }
  return stage('runtime.contract', 'not-applicable', 'Host authoring contract is not required for this provenance.')
}

function inspectManifest(record: CandidateRecord): ValidationStageResult {
  try {
    normalizeRegisterInput({
      owner: record.owner,
      version: record.version,
      provenance: record.provenance,
      status: 'candidate',
      evidence: 'Verified',
      capabilities: record.manifest.capabilities.map((id) => ({ id, permissions: [] })),
      permissions: record.manifest.permissions,
      runtimeSeams: record.manifest.runtimeSeams,
      tools: record.manifest.tools,
      services: record.manifest.services,
      providers: record.manifest.providers,
      pluginDependencies: record.manifest.pluginDependencies,
    })
    return stage('manifest.validate', 'passed', `Manifest for ${record.owner}@${record.version} is well-formed.`)
  } catch (error) {
    return stage(
      'manifest.validate',
      'failed',
      error instanceof Error ? error.message : 'Manifest is not compatible with the Registry contract.',
    )
  }
}

function inspectBoundary(root: string, files: readonly string[]): ValidationStageResult {
  const sources = files.filter((file) => file.endsWith('.ts') || file.endsWith('.js'))
  if (sources.length === 0) {
    return stage('source.boundary', 'not-applicable', 'No JavaScript/TypeScript sources to inspect.')
  }
  const hits: string[] = []
  for (const file of sources) {
    const text = readFileSync(path.join(root, file), 'utf8')
    if (FORBIDDEN_IMPORT.test(text)) hits.push(file)
  }
  return hits.length === 0
    ? stage('source.boundary', 'passed', 'No DSH package-internal src imports.')
    : stage('source.boundary', 'failed', 'Candidate sources import DSH package internals.', { diagnostics: hits.join(', ') })
}

function inspectGeneratedSourceContract(record: CandidateRecord, root: string, files: readonly string[]): ValidationStageResult {
  if (record.manifest.runtimeContractVersion !== 'generated-extension-api/v1') {
    return stage('source.contract', 'not-applicable', 'Generated source contract is not required for this provenance.')
  }
  const invalidEffects: string[] = []
  const undeclaredBrokerPermissions: string[] = []
  const sources = files.filter((file) => /\.(?:js|mjs|cjs)$/.test(file))
  for (const file of sources) {
    const text = readFileSync(path.join(root, file), 'utf8')
    try {
      const source = parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) as unknown as SyntaxNode
      walkSyntax(source, (node) => {
        if (isCtxEffectCall(node)) {
          const argument = node.arguments[0]
          if (node.arguments.length !== 1 || argument === undefined || !CALLBACK_NODE_TYPES.has(argument.type)) {
            invalidEffects.push(file)
          }
        }
        const brokerRequest = brokerRequestCapability(node)
        if (brokerRequest === undefined) return
        if (brokerRequest === null) {
          if (record.manifest.permissions.length === 0) undeclaredBrokerPermissions.push(`dynamic (${file})`)
          return
        }
        if (!record.manifest.permissions.includes(brokerRequest)) {
          undeclaredBrokerPermissions.push(`${brokerRequest} (${file})`)
        }
      })
    } catch {
      invalidEffects.push(file)
    }
  }
  if (invalidEffects.length > 0) {
    return stage(
      'source.contract',
      'failed',
      'generated-extension-api/v1 ctx.effect accepts only a cleanup setup callback.',
      { diagnostics: [...new Set(invalidEffects)].join(', ') },
    )
  }
  if (undeclaredBrokerPermissions.length > 0) {
    const operations = [...new Set(undeclaredBrokerPermissions)]
    return stage(
      'source.contract',
      'failed',
      `Generated source uses undeclared Broker permission ${operations.join(', ')}.`,
      { diagnostics: 'Add each broker operation used by source to manifest.permissions before validation.' },
    )
  }
  return stage(
    'source.contract',
    'passed',
    'Generated ctx.effect calls and Broker permission declarations match the host contract.',
  )
}

interface SyntaxNode {
  readonly type: string
  readonly [key: string]: unknown
}

const CALLBACK_NODE_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'Identifier',
  'MemberExpression',
])

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return value !== null && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

function walkSyntax(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    if (isSyntaxNode(value)) {
      walkSyntax(value, visit)
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) if (isSyntaxNode(item)) walkSyntax(item, visit)
    }
  }
}

function isCtxEffectCall(node: SyntaxNode): node is SyntaxNode & { readonly arguments: readonly SyntaxNode[] } {
  if (node.type !== 'CallExpression' || !Array.isArray(node.arguments) || !isSyntaxNode(node.callee)) return false
  const callee = node.callee
  if (callee.type !== 'MemberExpression' || callee.computed === true) return false
  if (!isSyntaxNode(callee.object) || !isSyntaxNode(callee.property)) return false
  return callee.object.type === 'Identifier'
    && callee.object.name === 'ctx'
    && callee.property.type === 'Identifier'
    && callee.property.name === 'effect'
}

function brokerRequestCapability(node: SyntaxNode): string | null | undefined {
  if (node.type !== 'CallExpression' || !Array.isArray(node.arguments) || !isSyntaxNode(node.callee)) return undefined
  const request = node.callee
  if (request.type !== 'MemberExpression' || request.computed === true) return undefined
  if (!isSyntaxNode(request.object) || !isSyntaxNode(request.property)) return undefined
  const broker = request.object
  if (broker.type !== 'MemberExpression' || broker.computed === true) return undefined
  if (!isSyntaxNode(broker.object) || !isSyntaxNode(broker.property)) return undefined
  const isBrokerRequest = broker.object.type === 'Identifier'
    && broker.object.name === 'ctx'
    && broker.property.type === 'Identifier'
    && broker.property.name === 'broker'
    && request.property.type === 'Identifier'
    && request.property.name === 'request'
  if (!isBrokerRequest) return undefined
  const capability = node.arguments[0]
  return capability?.type === 'Literal' && typeof capability.value === 'string'
    ? capability.value
    : null
}

function inspectBundle(root: string): ValidationStageResult {
  const hasBundle = existsSync(path.join(root, 'cordis.patch.yml')) || existsSync(path.join(root, 'package.json'))
  return hasBundle
    ? stage('bundle.inspect', 'passed', 'Recorded package/bundle metadata without installing it.')
    : stage('bundle.inspect', 'not-applicable', 'No package or bundle entry to inspect.')
}

function runTypecheck(root: string, files: readonly string[]): ValidationStageResult {
  const sources = files.filter((file) => file.endsWith('.ts'))
  if (sources.length === 0) {
    return stage('typecheck', 'not-applicable', 'No TypeScript sources.')
  }
  try {
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')
    const program = ts.createProgram(sources.map((file) => path.join(root, file)), {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      skipLibCheck: true,
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
    return diagnostics.length === 0
      ? stage('typecheck', 'passed', `Typecheck passed for ${sources.length} file(s).`)
      : stage('typecheck', 'failed', 'Typecheck failed.', { diagnostics: diagnostics.slice(0, 8).join('\n') })
  } catch (error) {
    return stage('typecheck', 'unresolved', 'TypeScript compiler is not available in this environment.', {
      diagnostics: error instanceof Error ? error.message : String(error),
    })
  }
}

function runTests(root: string, files: readonly string[]): ValidationStageResult {
  const tests = files.filter((file) => file.includes('.test.') || file.startsWith('test/'))
  if (tests.length === 0) {
    return stage('tests', 'not-applicable', 'No candidate tests declared. Offline validation does not invent a live suite.')
  }
  const executable = tests.filter((file) => file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs'))
  if (executable.length === 0) {
    return stage(
      'tests',
      'unresolved',
      'Candidate test files are inspectable but this pipeline only executes Node-native test files.',
      { diagnostics: tests.join(', ') },
    )
  }
  if (detectOsNetworkSandbox() === undefined) {
    return stage(
      'tests',
      'unresolved',
      'No OS/container network sandbox; candidate tests were not executed on the host.',
    )
  }
  try {
    const output = runRestrictedCandidateTests(root, executable)
    return stage('tests', 'passed', `Executed ${executable.length} candidate test file(s) inside an OS network sandbox.`, {
      diagnostics: output.slice(0, 2000),
    })
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string; code?: string }
    if (runnerUnavailable(failed)) {
      return stage(
        'tests',
        'unresolved',
        'Restricted validation runner is unavailable; candidate tests were not executed on the host.',
        { diagnostics: `${failed.stderr ?? failed.message ?? ''}`.slice(0, 2000) },
      )
    }
    return stage('tests', 'failed', 'Candidate tests failed in the restricted runner.', {
      diagnostics: `${failed.stdout ?? ''}\n${failed.stderr ?? failed.message ?? ''}`.slice(0, 2000),
    })
  }
}

function requestedUnsafe(record: CandidateRecord): string[] {
  const blocked: string[] = []
  for (const task of record.manifest.validationTasks) {
    const allowed = (ALLOWED_VALIDATION_TASKS as readonly string[]).includes(task.name)
    if (!allowed || task.argv !== undefined || task.script !== undefined) {
      blocked.push(task.script === undefined ? task.name : `${task.name}:${task.script}`)
    }
  }
  return blocked
}

export function runValidation(record: CandidateRecord, activeOwner?: OwnerExecutionFacts): ValidationReport {
  const files = listSourceFiles(record.workspaceRoot)
  const blocked = requestedUnsafe(record)
  const stages: ValidationStageResult[] = []
  if (blocked.length > 0) {
    stages.push(stage(
      'command.policy',
      'blocked',
      'Candidate requested a validation command outside the allowlisted development policy.',
      { diagnostics: blocked.join(', ') },
    ))
  }
  stages.push(inspectManifest(record))
  const reliability = evaluateReliability(record.manifest)
  stages.push(stage(
    'reliability.gate',
    reliability.passed ? 'passed' : 'failed',
    reliabilitySummary(reliability),
    { diagnostics: JSON.stringify({ derivedClass: reliability.derivedClass, checks: reliability.checks }) },
  ))
  stages.push(inspectPackage(
    record.workspaceRoot,
    record.manifest.runtimeContractVersion === 'generated-extension-api/v1',
  ))
  stages.push(inspectRuntimeContract(record))
  stages.push(inspectActivationCompatibility(record, activeOwner))
  stages.push(inspectGeneratedSourceContract(record, record.workspaceRoot, files))
  stages.push(inspectBoundary(record.workspaceRoot, files))
  stages.push(runTypecheck(record.workspaceRoot, files))
  stages.push(runTests(record.workspaceRoot, files))
  stages.push(inspectBundle(record.workspaceRoot))
  const digest = digestFiles(record.workspaceRoot, files, contractDigestExtras(record.manifest.runtimeContractVersion))
  stages.push(stage('digest', 'passed', `Bound validation evidence to digest ${digest.slice(0, 12)}.`))
  const unresolved = stages.filter((item) => item.status === 'unresolved').map((item) => item.summary)
  const complete = stages.every((item) => item.status === 'passed' || item.status === 'not-applicable')
  return {
    candidateId: record.id,
    digest,
    passed: complete && blocked.length === 0,
    stages,
    unresolved,
    blocked,
    reliability,
  }
}

export function lifecycleFromReport(report: ValidationReport): 'validated' | 'validation-failed' | 'validation-incomplete' {
  if (report.passed) return 'validated'
  const rejected = report.blocked.length > 0
    || report.stages.some((item) => item.status === 'failed' || item.status === 'blocked')
  return rejected ? 'validation-failed' : 'validation-incomplete'
}
