import { sanitizeProviderError } from '../integrations/sanitize.js'
import { sanitizeDiagnostic } from '../workbench/diagnostics.js'

const ACTIVATION_FAILURE_CHARS = 160

export function boundActivationDiagnostics(diagnostics: string): string {
  const cleaned = sanitizeProviderError(sanitizeDiagnostic(diagnostics)).replace(/\s+/g, ' ').trim()
  if (cleaned.length <= ACTIVATION_FAILURE_CHARS) return cleaned
  return `${cleaned.slice(0, ACTIVATION_FAILURE_CHARS - 12)}[truncated]`
}
