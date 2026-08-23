import { pathToFileURL } from 'node:url'
import type { CandidateRecord, ValidationStageResult } from '../candidate/types.js'

export const WORKBENCH_DIAGNOSTIC_STAGE_CHARS = 512
export const WORKBENCH_DIAGNOSTIC_TOTAL_BYTES = 4096

export interface ValidationStageDiagnostic {
  readonly name: string
  readonly status: ValidationStageResult['status']
  readonly summary: string
  readonly diagnostic?: string
  readonly file?: string
  readonly retryable: boolean
  readonly unresolved?: string
  readonly truncated: boolean
}

export interface ValidationDiagnosticsView {
  readonly candidateId: string
  readonly passed: boolean
  readonly stages: readonly ValidationStageDiagnostic[]
  readonly truncated: boolean
}

const POSIX_ABS = /(?:^|[^\w./-])((?:file:\/\/)?\/[^\s"'`)>\]]+)/g
const WIN_ABS = /(?:^|[^\w./-])((?:file:\/\/\/)?[A-Za-z]:\\[^\s"'`)>\]]+)/g
const WIN_FWD = /(?:^|[^\w./-])((?:file:\/\/\/)?[A-Za-z]:\/[^\s"'`)>\]]+)/g
const SECRETISH = /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi
const RELATIVE_FILE = /(?:src\/[A-Za-z0-9._/-]+\.(?:js|ts|mjs|cjs)|package\.json|generated-extension-api\.json)/

export function projectValidationDiagnostics(
  record: Pick<CandidateRecord, 'id' | 'workspaceRoot' | 'validation'>,
): ValidationDiagnosticsView {
  const stages = (record.validation?.stages ?? []).map((stage) => projectStage(stage, record.workspaceRoot))
  return boundDiagnosticsView({
    candidateId: record.id,
    passed: record.validation?.passed === true,
    stages,
    truncated: stages.some((item) => item.truncated),
  })
}

export function sanitizeDiagnostic(text: string, workspaceRoot?: string): string {
  let out = text.replaceAll('\0', '')
  for (const variant of rootVariants(workspaceRoot)) {
    out = out.split(variant).join('')
  }
  out = replaceAbs(out, POSIX_ABS, workspaceRoot)
  out = replaceAbs(out, WIN_ABS, workspaceRoot)
  out = replaceAbs(out, WIN_FWD, workspaceRoot)
  out = out.replace(SECRETISH, '[redacted]')
  return out.replaceAll(/\/{2,}/g, '/').trim()
}

function projectStage(stage: ValidationStageResult, workspaceRoot?: string): ValidationStageDiagnostic {
  const raw = sanitizeDiagnostic(stage.diagnostics ?? '', workspaceRoot)
  const { text, truncated } = boundText(raw, WORKBENCH_DIAGNOSTIC_STAGE_CHARS)
  return {
    name: stage.name,
    status: stage.status,
    summary: sanitizeDiagnostic(stage.summary, workspaceRoot).slice(0, 240),
    ...(text ? { diagnostic: text } : {}),
    ...(inferRelativeFile(`${stage.summary} ${raw}`, workspaceRoot) ? { file: inferRelativeFile(`${stage.summary} ${raw}`, workspaceRoot) } : {}),
    retryable: stage.status === 'failed' || stage.status === 'unresolved',
    ...(stage.status === 'unresolved' ? { unresolved: sanitizeDiagnostic(stage.summary, workspaceRoot).slice(0, 240) } : {}),
    truncated,
  }
}

function boundDiagnosticsView(view: ValidationDiagnosticsView): ValidationDiagnosticsView {
  let stages = [...view.stages]
  let truncated = view.truncated
  while (Buffer.byteLength(JSON.stringify({ ...view, stages }), 'utf8') > WORKBENCH_DIAGNOSTIC_TOTAL_BYTES && stages.some((item) => item.diagnostic)) {
    truncated = true
    const index = stages.map((item) => item.diagnostic?.length ?? 0).reduce((best, length, i, all) => length >= (all[best] ?? 0) ? i : best, 0)
    const current = stages[index]
    if (!current?.diagnostic) break
    const next = current.diagnostic.length <= 12 ? undefined : `${current.diagnostic.slice(0, Math.max(12, current.diagnostic.length - 64))}[truncated]`
    stages[index] = { ...current, diagnostic: next, truncated: true }
  }
  return { ...view, stages, truncated }
}

function boundText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  if (max <= 12) return { text: '[truncated]', truncated: true }
  return { text: `${text.slice(0, max - 12)}[truncated]`, truncated: true }
}

function replaceAbs(text: string, pattern: RegExp, workspaceRoot?: string): string {
  return text.replace(pattern, (match, abs: string) => match.replace(abs, inferRelativeFile(abs, workspaceRoot) ?? '[path]'))
}

function inferRelativeFile(text: string, workspaceRoot?: string): string | undefined {
  const match = text.match(RELATIVE_FILE)
  if (match?.[0]) return match[0]
  if (!workspaceRoot) return undefined
  for (const variant of rootVariants(workspaceRoot)) {
    const escaped = variant.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rooted = text.match(new RegExp(`${escaped}[/\\\\]([^\\s:'\"]+)`))
    if (rooted?.[1]) return rooted[1].replaceAll('\\', '/')
  }
  return undefined
}

function rootVariants(workspaceRoot?: string): readonly string[] {
  if (!workspaceRoot) return []
  const posix = workspaceRoot.replaceAll('\\', '/')
  const variants = [workspaceRoot, posix]
  try {
    variants.push(pathToFileURL(workspaceRoot).href)
  } catch {
    // ignore invalid roots
  }
  return [...new Set(variants)]
}
