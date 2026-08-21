import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { digestFiles } from './digest.js'
import { listSourceFiles } from './files.js'
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

function inspectPackage(root: string): ValidationStageResult {
  const pkgPath = path.join(root, 'package.json')
  if (!existsSync(pkgPath)) {
    return stage('package.inspect', 'not-applicable', 'No package.json in the candidate workspace.')
  }
  const raw = readFileSync(pkgPath, 'utf8')
  let parsed: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return stage('package.inspect', 'failed', 'package.json is not valid JSON.', { diagnostics: raw.slice(0, 500) })
  }
  const scripts = parsed.scripts ?? {}
  const lifecycle = Object.keys(scripts).filter((name) => LIFECYCLE_SCRIPTS.includes(name))
  const deps = { ...parsed.dependencies, ...parsed.devDependencies }
  const diagnostics = JSON.stringify({
    dependencies: Object.keys(deps),
    lifecycleScripts: lifecycle.map((name) => ({ name, command: scripts[name], executed: false, risk: 'blocked' })),
  })
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

function runTests(files: readonly string[]): ValidationStageResult {
  const tests = files.filter((file) => file.includes('.test.') || file.startsWith('test/'))
  return tests.length === 0
    ? stage('tests', 'not-applicable', 'No candidate tests declared. Offline validation does not invent a live suite.')
    : stage('tests', 'unresolved', 'Candidate test files are inspectable but are not executed in this pipeline.', {
      diagnostics: tests.join(', '),
    })
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

export function runValidation(record: CandidateRecord): ValidationReport {
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
  stages.push(stage('manifest.validate', 'passed', `Manifest for ${record.owner}@${record.version} is well-formed.`))
  stages.push(inspectPackage(record.workspaceRoot))
  stages.push(inspectBoundary(record.workspaceRoot, files))
  stages.push(runTypecheck(record.workspaceRoot, files))
  stages.push(runTests(files))
  stages.push(inspectBundle(record.workspaceRoot))
  const digest = digestFiles(record.workspaceRoot, files)
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
  }
}

export function lifecycleFromReport(report: ValidationReport): 'validated' | 'validation-failed' | 'validation-incomplete' {
  if (report.passed) return 'validated'
  const rejected = report.blocked.length > 0
    || report.stages.some((item) => item.status === 'failed' || item.status === 'blocked')
  return rejected ? 'validation-failed' : 'validation-incomplete'
}
