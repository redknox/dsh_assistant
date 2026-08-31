import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { runRestrictedCandidateTests, runnerUnavailable } from '../candidate/restricted-runner.js'
import type {
  CapabilityEvaluationExecutor,
  CapabilityEvaluationExecutorResult,
  CapabilityEvaluationReport,
  CapabilityEvaluationSuite,
  EvaluationFixture,
  EvaluationJson,
  EvaluationSpecificationInput,
} from './types.js'

export const CAPABILITY_EVALUATION_SUITE_STAMP = '.dsh/capability-evaluation.json'
export const CAPABILITY_EVALUATION_RUNNER = '.dsh/capability-evaluation-runner.mjs'
export const CAPABILITY_EVALUATION_VERSION = 'capability-evaluation/v1'
export const CAPABILITY_EVALUATION_REPORT_VERSION = 'capability-evaluation-report/v1'
const REPORT_MARKER = 'TARS_NG_CAPABILITY_EVALUATION '
const MAX_REPORT_CHARS = 32 * 1024

class RestrictedCapabilityEvaluationExecutor implements CapabilityEvaluationExecutor {
  run(workspaceRoot: string, runnerPath: string): CapabilityEvaluationExecutorResult {
    try {
      return { stdout: runRestrictedCandidateTests(workspaceRoot, [runnerPath]) }
    } catch (error) {
      const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string; code?: string }
      const stdout = typeof failure.stdout === 'string' ? failure.stdout : failure.stdout?.toString('utf8') ?? ''
      const diagnostics = `${typeof failure.stderr === 'string' ? failure.stderr : failure.stderr?.toString('utf8') ?? ''}\n${failure.message ?? ''}`.trim()
      return {
        stdout,
        diagnostics: diagnostics.slice(0, 2_000),
        ...(runnerUnavailable({ ...failure, stdout, stderr: diagnostics }) ? { unavailable: true } : {}),
      }
    }
  }
}

/** Host-owned preparation and isolated execution of business Acceptance Examples. */
export class CapabilityEvaluationHarness {
  constructor(private readonly executor: CapabilityEvaluationExecutor = new RestrictedCapabilityEvaluationExecutor()) {}

  prepare(specification: EvaluationSpecificationInput): Readonly<Record<string, string>> {
    const cases = specification.acceptanceExamples.flatMap((example) => example.fixture === undefined
      ? []
      : [{ name: example.name, input: example.fixture.input, expected: example.fixture.expected }])
    if (cases.length === 0) return {}
    const suite: CapabilityEvaluationSuite = {
      version: CAPABILITY_EVALUATION_VERSION,
      specificationId: specification.id,
      specificationDigest: specification.digest,
      capability: specification.capability,
      cases,
    }
    return {
      [CAPABILITY_EVALUATION_SUITE_STAMP]: `${JSON.stringify(suite, null, 2)}\n`,
      [CAPABILITY_EVALUATION_RUNNER]: EVALUATION_RUNNER_SOURCE,
    }
  }

  evaluate(input: { readonly candidateId: string; readonly workspaceRoot: string }): CapabilityEvaluationReport {
    const suitePath = path.join(input.workspaceRoot, CAPABILITY_EVALUATION_SUITE_STAMP)
    const runnerPath = path.join(input.workspaceRoot, CAPABILITY_EVALUATION_RUNNER)
    if (!existsSync(suitePath) && !existsSync(runnerPath)) {
      return report(input.candidateId, 'not-applicable', 'No executable Evaluation Fixtures are bound to this Candidate.')
    }
    if (!existsSync(suitePath) || !existsSync(runnerPath)) {
      return report(input.candidateId, 'failed', 'Host-owned Capability Evaluation assets are incomplete.')
    }
    if (readFileSync(runnerPath, 'utf8') !== EVALUATION_RUNNER_SOURCE) {
      return report(input.candidateId, 'failed', 'Host-owned Capability Evaluation runner was modified.')
    }
    const suite = parseSuite(readFileSync(suitePath, 'utf8'))
    if (suite === undefined) return report(input.candidateId, 'failed', 'Capability Evaluation suite is malformed.')
    const execution = this.executor.run(input.workspaceRoot, CAPABILITY_EVALUATION_RUNNER)
    const parsed = parseRunnerReport(execution.stdout, input.candidateId, suite)
    if (parsed !== undefined) return parsed
    if (execution.unavailable) {
      return report(input.candidateId, 'unresolved', 'Capability Evaluation isolation is unavailable.', suite)
    }
    return report(
      input.candidateId,
      'failed',
      execution.diagnostics ? `Capability Evaluation runner failed: ${execution.diagnostics}` : 'Capability Evaluation runner returned no evidence.',
      suite,
    )
  }
}

export function normalizeEvaluationFixture(value: unknown, label: string): EvaluationFixture {
  if (!isRecord(value) || !Object.hasOwn(value, 'input') || !Object.hasOwn(value, 'expected')) {
    throw new TypeError(`${label} fixture must contain both input and expected`)
  }
  if (!isRecord(value.input)) throw new TypeError(`${label} fixture input must be a JSON object`)
  return {
    input: normalizeJson(value.input, `${label}.input`) as { readonly [key: string]: EvaluationJson },
    expected: normalizeJson(value.expected, `${label}.expected`),
  }
}

function normalizeJson(value: unknown, label: string, depth = 0): EvaluationJson {
  if (depth > 12) throw new TypeError(`${label} exceeds the JSON depth bound`)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite JSON data`)
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new TypeError(`${label} exceeds the JSON array bound`)
    return value.map((item, index) => normalizeJson(item, `${label}[${index}]`, depth + 1))
  }
  if (!isRecord(value)) throw new TypeError(`${label} must be JSON data`)
  const entries = Object.entries(value)
  if (entries.length > 200) throw new TypeError(`${label} exceeds the JSON object bound`)
  return Object.fromEntries(entries.map(([key, item]) => {
    if (key.length === 0 || key.length > 160) throw new TypeError(`${label} contains an invalid JSON key`)
    return [key, normalizeJson(item, `${label}.${key}`, depth + 1)]
  }))
}

function parseSuite(raw: string): CapabilityEvaluationSuite | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)
      || value.version !== CAPABILITY_EVALUATION_VERSION
      || typeof value.specificationId !== 'string'
      || typeof value.specificationDigest !== 'string'
      || typeof value.capability !== 'string'
      || !Array.isArray(value.cases)
      || value.cases.length === 0
      || value.cases.length > 40) return undefined
    const cases = value.cases.map((item, index) => {
      if (!isRecord(item) || typeof item.name !== 'string') throw new TypeError('case')
      return {
        name: item.name,
        input: normalizeEvaluationFixture({ input: item.input, expected: item.expected }, `cases[${index}]`).input,
        expected: normalizeEvaluationFixture({ input: item.input, expected: item.expected }, `cases[${index}]`).expected,
      }
    })
    return {
      version: CAPABILITY_EVALUATION_VERSION,
      specificationId: value.specificationId,
      specificationDigest: value.specificationDigest,
      capability: value.capability,
      cases,
    }
  } catch {
    return undefined
  }
}

function parseRunnerReport(
  stdout: string,
  candidateId: string,
  suite: CapabilityEvaluationSuite,
): CapabilityEvaluationReport | undefined {
  const line = [...stdout.split('\n')].reverse().find((item: string) => item.startsWith(REPORT_MARKER))
  if (line === undefined || line.length > MAX_REPORT_CHARS) return undefined
  try {
    const value = JSON.parse(line.slice(REPORT_MARKER.length)) as Omit<CapabilityEvaluationReport, 'candidateId' | 'version'>
    if ((value.status !== 'passed' && value.status !== 'failed')
      || value.specificationId !== suite.specificationId
      || value.specificationDigest !== suite.specificationDigest
      || value.capability !== suite.capability
      || !Array.isArray(value.cases)
      || value.cases.length !== suite.cases.length
      || typeof value.executed !== 'number'
      || typeof value.summary !== 'string') return undefined
    return { ...value, version: CAPABILITY_EVALUATION_REPORT_VERSION, candidateId }
  } catch {
    return undefined
  }
}

function report(
  candidateId: string,
  status: CapabilityEvaluationReport['status'],
  summary: string,
  suite?: CapabilityEvaluationSuite,
): CapabilityEvaluationReport {
  return {
    version: CAPABILITY_EVALUATION_REPORT_VERSION,
    candidateId,
    ...(suite === undefined ? {} : {
      specificationId: suite.specificationId,
      specificationDigest: suite.specificationDigest,
      capability: suite.capability,
    }),
    status,
    executed: 0,
    cases: [],
    summary: summary.slice(0, 2_000),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const EVALUATION_RUNNER_SOURCE = `import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const marker = ${JSON.stringify(REPORT_MARKER)}
const suite = JSON.parse(await readFile(${JSON.stringify(CAPABILITY_EVALUATION_SUITE_STAMP)}, 'utf8'))
const manifest = JSON.parse(await readFile('candidate.manifest.json', 'utf8'))
const tools = new Map()
const disposers = []
const ctx = {
  tools: {
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
    get(name) { return tools.get(name) },
  },
  effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); return dispose ?? (() => {}) },
  broker: { request() { throw new Error('host Broker is unavailable during Capability Evaluation') } },
  get() { throw new Error('live host context is unavailable during Capability Evaluation') },
  plugin() { throw new Error('host plugin mounting is unavailable during Capability Evaluation') },
}
const entry = manifest.entryPoints?.[0]
if (typeof entry !== 'string' || manifest.entryPoints.length !== 1) throw new Error('Capability Evaluation requires one candidate entry point')
const imported = await import(pathToFileURL(path.resolve(entry)).href)
const plugin = imported.default ?? imported
await (plugin.apply ?? imported.apply)(ctx)
if (!Array.isArray(manifest.tools) || manifest.tools.length !== 1) throw new Error('Capability Evaluation requires one declared tool')
const tool = tools.get(manifest.tools[0])
if (!tool?.execute) throw new Error('declared Capability Evaluation tool was not registered')
const cases = []
for (const fixture of suite.cases) {
  try {
    const actual = await tool.execute(structuredClone(fixture.input))
    assert.deepStrictEqual(actual, fixture.expected)
    cases.push({ ...fixture, status: 'passed', actual })
  } catch (error) {
    const actual = error?.actual
    cases.push({ ...fixture, status: 'failed', ...(actual === undefined ? {} : { actual }), error: String(error?.message ?? error).slice(0, 500) })
  }
}
for (const dispose of disposers.reverse()) await dispose()
const failed = cases.filter((item) => item.status === 'failed').length
const report = {
  specificationId: suite.specificationId,
  specificationDigest: suite.specificationDigest,
  capability: suite.capability,
  status: failed === 0 ? 'passed' : 'failed',
  executed: cases.length,
  cases,
  summary: failed === 0 ? \`Passed \${cases.length} business acceptance case(s).\` : \`Failed \${failed} of \${cases.length} business acceptance case(s).\`,
}
process.stdout.write(marker + JSON.stringify(report) + '\\n')
if (failed > 0) process.exitCode = 1
`
