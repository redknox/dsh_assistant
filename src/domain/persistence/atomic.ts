import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Temp file + fsync + atomic rename. Authority writes must not leave a half-written file. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const payload = `${JSON.stringify(value, null, 2)}\n`
  const tempPath = `${filePath}.${process.pid}.tmp`
  const fd = openSync(tempPath, 'w')
  try {
    writeSync(fd, payload)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tempPath, filePath)
}
