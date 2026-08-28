import type { Context } from '@deepseek-ai/cordis'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as FirstPromptSessionTitle from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { productHomeLayout } from './home.js'

export interface SessionIntelligenceConfig {
  readonly home?: string
}

/** Mount log-backed titles and a disposable, durable full-text session index. */
export async function mountSessionIntelligence(ctx: Context, config: SessionIntelligenceConfig = {}): Promise<void> {
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  await ctx.plugin(FirstPromptSessionTitle, {
    targetWords: 5,
    targetCjkCharacters: 10,
    maxInputBytes: 4096,
    maxOutputTokens: 64,
    timeoutMs: 60_000,
  })
  await ctx.plugin(SqliteSessionQueryEngine, {
    path: config.home ? productHomeLayout(config.home).sessionQueryIndex : ':memory:',
    openAt: 'first-search',
  })
}
