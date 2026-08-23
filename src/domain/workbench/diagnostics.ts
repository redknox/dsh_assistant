import type { CandidateRecord, ValidationStageResult } from '../candidate/types.js'

export const WORKBENCH_DIAGNOSTIC_STAGE_CHARS = 512
export const WORKBENCH_DIAGNOSTIC_TOTAL_CHARS = 2048

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

const ABS_PATH = /(?:^|[\s"'`=(])(\/(?:Users|home|tmp|var|etc|private)[^\s"'`)>\]]+)/g
const SECRETISH = /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi

export function projectValidationDiagnostics(
  record: Pick<CandidateRecord, 'id' | 'workspaceRoot' | 'validation'>,
): ValidationDiagnosticsView {
  const stages: ValidationStageDiagnostic[] = []
  let used = 0
  let truncated = false
  for (const stage of record.validation?.stages ?? []) {
    const raw = sanitizeDiagnostic(stage.diagnostics ?? stage.summary, record.workspaceRoot)
    const budget = Math.max(0, WORKBENCH_DIAGNOSTIC_TOTAL_CHARS - used)
    const { text, truncated: stageTruncated } = boundText(raw, Math.min(WORKBENCH_DIAGNOSTIC_STAGE_CHARS, budget))
    if (raw.length > 0 && budget === 0) {
      truncated = true
      break
    }
    used += text.length
    truncated = truncated || stageTruncated
    stages.push({
      name: stage.name,
      status: stage.status,
      summary: sanitizeDiagnostic(stage.summary, record.workspaceRoot).slice(0, 240),
      ...(text ? { diagnostic: text } : {}),
      ...(inferRelativeFile(raw, record.workspaceRoot) ? { file: inferRelativeFile(raw, record.workspaceRoot) } : {}),
      retryable: stage.status === 'failed' || stage.status === 'unresolved',
      ...(stage.status === 'unresolved' ? { unresolved: stage.summary } : {}),
      truncated: stageTruncated,
    })
  }
  return {
    candidateId: record.id,
    passed: record.validation?.passed === true,
    stages,
    truncated,
  }
}

export function sanitizeDiagnostic(text: string, workspaceRoot?: string): string {
  let out = text.replaceAll('\0', '')
  if (workspaceRoot) {
    out = out.split(workspaceRoot).join('')
    out = out.split(workspaceRoot.replaceAll('\\', '/')).join('')
  }
  out = out.replace(ABS_PATH, ' [path]')
  out = out.replace(SECRETISH, '[redacted]')
  return out.replaceAll(/\/{2,}/g, '/').trim()
}

function boundText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  if (max <= 12) return { text: '[truncated]', truncated: true }
  return { text: `${text.slice(0, max - 12)}[truncated]`, truncated: true }
}

function inferRelativeFile(text: string, workspaceRoot?: string): string | undefined {
  const match = text.match(/(src\/[A-Za-z0-9._/-]+\.(?:js|ts|mjs|cjs)|package\.json|generated-extension-api\.json)/)
  if (match?.[1]) return match[1]
  if (!workspaceRoot) return undefined
  const escaped = workspaceRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rooted = text.match(new RegExp(`${escaped}[/\\\\]([^\\s:'\"]+)`))
  return rooted?.[1]?.replaceAll('\\', '/')
}
