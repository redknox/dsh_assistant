import path from 'node:path'
import { ConfinedRootFiles } from './confined-root-files.js'
import { deleteConfinedText, listConfinedTextFiles } from '../../domain/files/confined-root.js'
import type { FileEntry, FilesProvider } from '../../domain/integrations/hub.js'
import {
  IntegrationError,
  MAX_PAGE_SIZE,
  throwIfAborted,
  type Availability,
  type Page,
  type PageQuery,
} from '../../domain/integrations/types.js'

function pageFiles(items: readonly FileEntry[], query: PageQuery): Page<FileEntry> {
  throwIfAborted('files', query.signal)
  const limit = query.limit === undefined ? 10 : query.limit
  if (!Number.isInteger(limit) || limit < 1) {
    throw new IntegrationError('files', 'invalid_request', 'limit must be a positive integer')
  }
  const size = Math.min(limit, MAX_PAGE_SIZE)
  const start = query.cursor ? Number.parseInt(query.cursor, 10) : 0
  if (!Number.isFinite(start) || start < 0) {
    throw new IntegrationError('files', 'invalid_request', 'cursor is invalid')
  }
  const slice = items.slice(start, start + size)
  const next = start + size < items.length ? String(start + size) : undefined
  return next ? { items: slice, nextCursor: next } : { items: slice }
}

/** FilesProvider locked to one operator sandbox root. Caller-supplied roots are ignored. */
export function createSandboxFilesProvider(root: string): FilesProvider {
  const confined = new ConfinedRootFiles()
  return {
    capability: 'files',
    availability(): Availability {
      return { available: true, provider: 'sandbox' }
    },
    confinedAccesses() {
      return confined.confinedAccesses()
    },
    listTextFiles(input) {
      return confined.listTextFiles({ root, prefix: input.prefix })
    },
    readText(input) {
      return confined.readText({ root, path: input.path })
    },
    writeText(input) {
      return confined.writeText({ root, path: input.path, content: input.content })
    },
    async listFiles(query: { path?: string } & PageQuery): Promise<Page<FileEntry>> {
      throwIfAborted('files', query.signal)
      try {
        const paths = listConfinedTextFiles(root, query.path ?? '', '')
        return pageFiles(paths.map((relative) => ({
          id: relative,
          name: path.posix.basename(relative),
          kind: 'file' as const,
        })), query)
      } catch (error) {
        if (error instanceof IntegrationError) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new IntegrationError('files', 'invalid_request', message)
      }
    },
    async deleteFile(id: string, signal?: AbortSignal): Promise<{ id: string; deleted: true }> {
      throwIfAborted('files', signal)
      try {
        deleteConfinedText(root, id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new IntegrationError('files', 'invalid_request', message)
      }
      return { id, deleted: true }
    },
  }
}
