import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import FileReferenceService, {
  FILE_REFERENCE_PROMPT,
  type FileReferenceCandidate,
} from '@deepseek-ai/dsh-file-reference'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'

const MAX_REFERENCE_CANDIDATES = 24
const PAGE_SIZE = 100
const mountedFileReferences = new WeakSet<Context>()
const mountedImageStores = new WeakSet<Context>()

import type { MaterialInputView } from '../domain/workspace/types.js'

class SandboxFileReferenceService extends FileReferenceService {
  constructor(ctx: Context) {
    super(ctx)
  }

  async list(_agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    if (query.length > 512 || /[\u0000-\u001f\u007f]/u.test(query)) return []
    if (this.ctx.integrations.hub.status().files.available !== true) return []
    const files = this.ctx.integrations.hub.files()

    const paths: string[] = []
    let cursor: string | undefined
    do {
      const page = await files.listFiles({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}), signal })
      paths.push(...page.items.filter((item) => item.kind === 'file').map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor !== undefined)

    const candidates = candidatesOf(paths)
    const normalized = query.trimStart().toLocaleLowerCase()
    return candidates
      .filter((candidate) => normalized === '' || candidate.path.toLocaleLowerCase().includes(normalized))
      .slice(0, MAX_REFERENCE_CANDIDATES)
  }
}

function candidatesOf(paths: readonly string[]): FileReferenceCandidate[] {
  const directories = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'))
    }
  }
  return [
    ...[...directories].sort().map((path) => ({ path, kind: 'directory' as const })),
    ...[...new Set(paths)].sort().map((path) => ({ path, kind: 'file' as const })),
  ]
}

/** Mount durable image storage plus browser-safe references to the governed Files namespace. */
export async function mountMaterialInput(ctx: Context, options: { readonly home?: string } = {}): Promise<void> {
  await ctx.plugin(LocalAttachmentStore, options.home ? { dshHome: options.home } : {})
  mountedImageStores.add(ctx)
  await ctx.plugin(SandboxFileReferenceService)
  mountedFileReferences.add(ctx)
  ctx.systemPrompt.section({
    name: 'product:file-references',
    order: 41,
    text: `${FILE_REFERENCE_PROMPT} References resolve inside the configured operator Files sandbox, not the host filesystem.`,
  })
}

export function inspectMaterialInput(ctx: Context): MaterialInputView {
  const filesAvailable = (ctx.get('integrations') as {
    hub: { status(): { files: { available: boolean } } }
  } | undefined)?.hub.status().files.available === true
  return {
    fileReferences: mountedFileReferences.has(ctx) && filesAvailable ? 'active' : 'unavailable',
    imageStore: mountedImageStores.has(ctx) ? 'ready' : 'unavailable',
    imageInput: 'unsupported',
  }
}
