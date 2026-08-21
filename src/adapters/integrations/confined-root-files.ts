import {
  listConfinedTextFiles,
  readConfinedText,
  writeConfinedText,
} from '../../domain/files/confined-root.js'
import { IntegrationError } from '../../domain/integrations/types.js'
import type { ConfinedFileAccess, ConfinedFileOp } from '../../domain/integrations/hub.js'

function wrap<T>(op: () => T): T {
  try {
    return op()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new IntegrationError('files', 'invalid_request', message)
  }
}

/** Disk-backed confined-root access on the public files seam. */
export class ConfinedRootFiles implements ConfinedFileAccess {
  readonly accesses: ConfinedFileOp[] = []

  confinedAccesses(): readonly ConfinedFileOp[] {
    return this.accesses
  }

  async listTextFiles(input: { root: string; prefix?: string }): Promise<readonly string[]> {
    this.accesses.push({ op: 'list', root: input.root, path: input.prefix })
    return wrap(() => listConfinedTextFiles(input.root, input.prefix ?? ''))
  }

  async readText(input: { root: string; path: string }): Promise<string> {
    this.accesses.push({ op: 'read', root: input.root, path: input.path })
    return wrap(() => readConfinedText(input.root, input.path))
  }

  async writeText(input: { root: string; path: string; content: string }): Promise<void> {
    this.accesses.push({ op: 'write', root: input.root, path: input.path })
    wrap(() => writeConfinedText(input.root, input.path, input.content))
  }
}
