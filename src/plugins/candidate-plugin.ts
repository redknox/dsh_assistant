import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { CandidateService } from '../domain/candidate/index.js'
import type { CandidateValidation, CandidateWorkspace } from '../domain/candidate/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    candidateWorkspace: CandidateWorkspace
    candidateValidation: CandidateValidation
  }
}

export class CandidateWorkspaceService extends Service implements CandidateWorkspace {
  constructor(
    ctx: Context,
    private readonly store: CandidateWorkspace,
  ) {
    super(ctx, 'candidateWorkspace')
  }

  create(input: Parameters<CandidateWorkspace['create']>[0]) { return this.store.create(input) }
  get(id: string) { return this.store.get(id) }
  list() { return this.store.list() }
  writeFile(id: string, relativePath: string, content: string) { return this.store.writeFile(id, relativePath, content) }
  readFile(id: string, relativePath: string) { return this.store.readFile(id, relativePath) }
  listFiles(id: string) { return this.store.listFiles(id) }
  link(id: string, relativePath: string, target: string): never { return this.store.link(id, relativePath, target) }
  setManifest(id: string, manifest: Parameters<CandidateWorkspace['setManifest']>[1]) { return this.store.setManifest(id, manifest) }
  diff(id: string) { return this.store.diff(id) }
  discard(id: string) { return this.store.discard(id) }
  seal(id: string) { return this.store.seal(id) }
}

export class CandidateValidationService extends Service implements CandidateValidation {
  constructor(
    ctx: Context,
    private readonly store: CandidateValidation,
  ) {
    super(ctx, 'candidateValidation')
  }

  validate(id: string) { return this.store.validate(id) }
}

export interface CandidatePluginConfig {
  readonly workspaceRoot?: string
  readonly restore?: import('../domain/candidate/types.js').CandidateRecord[]
  readonly persist?: (records: readonly import('../domain/candidate/types.js').CandidateRecord[]) => void
}

export const name = 'dsh-assistant-candidate'
export const inject = ['capabilityRegistry']

/** Candidate workspace + validation. Never installs, approves, or mounts plugins. */
export async function apply(ctx: Context, config: CandidatePluginConfig = {}) {
  const areaRoot = config.workspaceRoot ?? mkdtempSync(path.join(tmpdir(), 'dsh-assistant-candidates-'))
  const store = new CandidateService(ctx.capabilityRegistry, areaRoot, {
    restore: config.restore,
    persist: config.persist,
  })
  await ctx.plugin(class extends CandidateWorkspaceService {
    constructor(scope: Context) {
      super(scope, store)
    }
  })
  await ctx.plugin(class extends CandidateValidationService {
    constructor(scope: Context) {
      super(scope, store)
    }
  })
}
