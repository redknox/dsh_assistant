import type { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine, { type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ContextEnduranceView } from '../domain/workspace/types.js'

export const DEFAULT_MAX_INLINE_TOOL_BYTES = 50_000
const inlineBudgets = new WeakMap<Context, number>()

export interface ContextEnduranceConfig extends BasicCompactionConfig {
  readonly spillRoot?: string
  readonly maxInlineToolBytes?: number
}

/** Mount the native DSH Context Endurance stack behind one product seam. */
export async function mountContextEndurance(ctx: Context, config: ContextEnduranceConfig = {}): Promise<void> {
  const { spillRoot, maxInlineToolBytes, ...compactionConfig } = config
  const inlineBudget = maxInlineToolBytes ?? DEFAULT_MAX_INLINE_TOOL_BYTES
  inlineBudgets.set(ctx, inlineBudget)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LocalSpillStore, spillRoot ? { root: spillRoot } : {})
  await ctx.plugin(SpillPolicy, {
    maxInlineBytes: inlineBudget,
  })
  await ctx.plugin(ToolResultPruner, {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  })
  await ctx.plugin(BasicCompactionEngine, compactionConfig)
}

/** Produce one browser-safe snapshot without exposing DSH lifecycle details. */
export function inspectContextEndurance(ctx: Context, session: Session | undefined): ContextEnduranceView | undefined {
  if (!session || !ctx.get('tokenMeter')) return undefined
  const compaction = ctx.get('compaction') ? 'automatic' as const : 'unavailable' as const
  const maxInlineBytes = inlineBudgets.get(ctx) ?? DEFAULT_MAX_INLINE_TOOL_BYTES
  try {
    const measurement = ctx.tokenMeter.measure(session)
    const projections = ctx.get('sessionProjections')?.snapshot(session).values
    const pressure = projections?.contextPressure
    const usage = projections?.tokenUsage
    const measuredTokens = pressure?.projectedTokens ?? measurement.totalTokens
    const contextWindow = pressure?.contextWindow
    return {
      status: 'ready',
      measuredTokens,
      ...(pressure?.pressureTokens !== undefined ? { pressureTokens: pressure.pressureTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(contextWindow !== undefined && contextWindow > 0
        ? { occupancyPercent: Math.round((measuredTokens / contextWindow) * 1000) / 10 }
        : {}),
      ...(projections?.contextBreakdown ? { breakdown: projections.contextBreakdown } : {}),
      ...(usage
        ? {
            cumulativeUsage: {
              inputTokens: usage.uncachedInputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
            },
          }
        : {}),
      compaction,
      outputRetention: {
        maxInlineBytes,
        spill: ctx.get('spillStore') ? 'ready' : 'unavailable',
      },
    }
  } catch {
    return {
      status: 'degraded',
      compaction,
      outputRetention: {
        maxInlineBytes,
        spill: ctx.get('spillStore') ? 'ready' : 'unavailable',
      },
    }
  }
}
