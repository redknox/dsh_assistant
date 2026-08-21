import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_LLM_CREDENTIAL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
} from './constants.js'

export interface LlmDiagnosis {
  readonly provider: string
  readonly model: string
  readonly credential: string
  readonly credentialPresent: boolean
  readonly routeAvailable: boolean
  readonly advertisedModels: readonly string[]
  readonly usable: boolean
  readonly state: 'configured' | 'LLM not configured/unavailable'
  readonly note: string
}

export function llmCredentialPresent(): boolean {
  return Boolean(process.env[DEFAULT_LLM_CREDENTIAL])
}

export async function inspectLlmRuntime(ctx?: Context): Promise<LlmDiagnosis> {
  const credentialPresent = llmCredentialPresent()
  let routeAvailable = false
  let advertisedModels: string[] = []
  if (ctx?.llm) {
    try {
      const models = await ctx.llm.listModels(DEFAULT_LLM_PROVIDER)
      advertisedModels = models.map((item) => item.id)
      await ctx.llm.resolveModelInfo(DEFAULT_LLM_PROVIDER, DEFAULT_LLM_MODEL)
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      routeAvailable = advertisedModels.includes(DEFAULT_LLM_MODEL)
        && selection?.provider === DEFAULT_LLM_PROVIDER
        && selection?.model === DEFAULT_LLM_MODEL
    } catch {
      routeAvailable = false
    }
  }
  const usable = credentialPresent && routeAvailable
  return {
    provider: DEFAULT_LLM_PROVIDER,
    model: DEFAULT_LLM_MODEL,
    credential: DEFAULT_LLM_CREDENTIAL,
    credentialPresent,
    routeAvailable,
    advertisedModels,
    usable,
    state: usable ? 'configured' : 'LLM not configured/unavailable',
    note: usable
      ? `Soak baseline ${DEFAULT_LLM_PROVIDER} / ${DEFAULT_LLM_MODEL} is configured.`
      : credentialPresent
        ? `Provider route ${DEFAULT_LLM_PROVIDER} / ${DEFAULT_LLM_MODEL} is not available on this runtime.`
        : `Set ${DEFAULT_LLM_CREDENTIAL} in the env file (chmod 600). Product start is not a usable AI runtime until the key is present.`,
  }
}
