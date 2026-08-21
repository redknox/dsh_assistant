import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-assistant'
export const inject = ['systemPrompt']

/**
 * Product identity remains a distinct prompt contribution.
 * Layered personality lives on `ctx.tarsPersonality` (core / policy / expression).
 */
export function apply(_ctx: Context) {}
