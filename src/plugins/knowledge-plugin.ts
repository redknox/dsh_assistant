import { Service, type Context } from '@deepseek-ai/cordis'
import { ingestLocalTextFile } from '../adapters/knowledge/local-file-ingest.js'
import { ObsidianVaultAccess, scanObsidianVault } from '../adapters/knowledge/obsidian-vault.js'
import { KnowledgeService } from '../domain/knowledge/service.js'
import type { PersonalKnowledge } from '../domain/knowledge/types.js'
import { registerKnowledgeTools } from './knowledge-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    personalKnowledge: PersonalKnowledge
    obsidianVault: ObsidianVaultAccessService
  }
}

export class ObsidianVaultAccessService extends Service {
  constructor(ctx: Context, readonly access: ObsidianVaultAccess) {
    super(ctx, 'obsidianVault')
  }
}

export class PersonalKnowledgeService extends Service implements PersonalKnowledge {
  constructor(
    ctx: Context,
    private readonly store: PersonalKnowledge,
  ) {
    super(ctx, 'personalKnowledge')
  }

  ingest(input: Parameters<PersonalKnowledge['ingest']>[0]) {
    return this.store.ingest(input)
  }

  retrieve(query: Parameters<PersonalKnowledge['retrieve']>[0]) {
    return this.store.retrieve(query)
  }

  getDocument(id: string) {
    return this.store.getDocument(id)
  }

  listDocuments() {
    return this.store.listDocuments()
  }
}

export interface KnowledgePluginConfig {
  /** Explicit local files to ingest at boot. Never scans the user's machine. */
  fixturePaths?: string[]
  /** Explicit Obsidian Vault root. Reads are bounded; create/append writes require ActionPolicy approval. */
  obsidianVaultPath?: string
}

export const name = 'dsh-assistant-knowledge'
export const inject = ['systemPrompt', 'tools']

export async function apply(ctx: Context, config: KnowledgePluginConfig = {}) {
  const knowledge = new KnowledgeService()
  for (const path of config.fixturePaths ?? []) {
    knowledge.ingest(ingestLocalTextFile(path, 'fixture'))
  }
  let obsidian: ObsidianVaultAccess | undefined
  if (config.obsidianVaultPath) {
    for (const note of scanObsidianVault(config.obsidianVaultPath)) knowledge.ingest(note)
    obsidian = new ObsidianVaultAccess(config.obsidianVaultPath, (note) => knowledge.ingest(note))
  }
  await ctx.plugin(class extends PersonalKnowledgeService {
    constructor(scope: Context) {
      super(scope, knowledge)
    }
  })
  if (obsidian) {
    const access = obsidian
    await ctx.plugin(class extends ObsidianVaultAccessService {
      constructor(scope: Context) { super(scope, access) }
    })
  }
  ctx.systemPrompt.section({
    name: 'product:knowledge',
    order: 30,
    text: `Reference material is retrieved with retrieve_knowledge. Retrieved knowledge is not personal memory and must not be stored with remember_memory unless the user explicitly asks.${obsidian ? ' Obsidian writes are limited to creating a new note or appending to an existing note. Call the matching obsidian_propose_* tool first, then the obsidian_* execute tool; execution always requires exact human confirmation.' : ''}`,
  })
  ctx.effect(() => registerKnowledgeTools(ctx.tools, knowledge, obsidian))
}
