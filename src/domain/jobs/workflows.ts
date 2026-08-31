import type { IntegrationHub } from '../integrations/hub.js'
import type { PersonalKnowledge } from '../knowledge/types.js'
import type { PolicyService } from '../policy/service.js'
import type { WorkflowDefinition } from './types.js'
import { buildWorkBrief } from './work-brief.js'

export interface MorningBriefClock {
  now(): Date
}

export function morningBriefWorkflow(
  hub: IntegrationHub,
  knowledge: PersonalKnowledge | undefined,
  clock: MorningBriefClock,
): WorkflowDefinition {
  return {
    name: 'morning-brief',
    title: 'Morning brief',
    schedule: { kind: 'every', everyMs: 24 * 60 * 60 * 1000 },
    intent: 'read',
    async run({ signal }) {
      return buildWorkBrief({ hub, knowledge, now: clock.now(), signal })
    },
  }
}

export function createFollowupTaskWorkflow(policy: PolicyService): WorkflowDefinition {
  return {
    name: 'create-followup-task',
    title: 'Create follow-up task',
    schedule: { kind: 'manual' },
    intent: 'execute',
    async run({ signal, input }) {
      const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Review morning brief'
      const outcome = await policy.apply({
        capability: 'tasks',
        operation: 'create',
        intent: 'execute',
        payload: { title },
        signal,
      })
      return JSON.stringify({ kind: outcome.kind, level: 'level' in outcome ? outcome.level : undefined })
    },
  }
}

export function deleteFileWorkflow(policy: PolicyService): WorkflowDefinition {
  return {
    name: 'delete-file',
    title: 'Delete a file',
    schedule: { kind: 'manual' },
    intent: 'execute',
    async run({ signal, input }) {
      const id = typeof input.id === 'string' ? input.id : 'f-1'
      const outcome = await policy.apply({
        capability: 'files',
        operation: 'delete',
        intent: 'execute',
        payload: { id },
        signal,
      })
      return JSON.stringify({
        kind: outcome.kind,
        code: outcome.kind === 'deny' ? outcome.code : undefined,
        confirmationId: outcome.kind === 'pending_confirmation' ? outcome.confirmationId : undefined,
      })
    },
  }
}
