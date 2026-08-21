import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { sanitizeProviderError } from '../domain/integrations/sanitize.js'

const MAX_LOG_BYTES = 2 * 1024 * 1024

export function appendProductLog(logFile: string, line: string): void {
  if (existsSync(logFile)) {
    try {
      if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`)
    } catch {
      // Rotation is best-effort.
    }
  }
  const stamp = new Date().toISOString()
  appendFileSync(logFile, `${stamp} ${sanitizeProviderError(line).replace(/\s+/g, ' ').trim()}\n`, { mode: 0o600 })
}
