import type { IntegrationHub } from '../integrations/hub.js'
import type { PersonalKnowledge } from '../knowledge/types.js'
import type { PolicyService } from '../policy/service.js'
import type { WorkflowDefinition } from './types.js'

export interface MorningBriefClock {
  now(): Date
}

function dayRange(now: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { from: from.toISOString(), to: to.toISOString() }
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
      if (signal.aborted) throw new Error('cancelled')
      const range = dayRange(clock.now())
      const events = await hub.calendar().listEvents({ ...range, signal })
      const tasks = await hub.tasks().listTasks({ signal })
      const notes = knowledge?.retrieve({ text: 'office hours', limit: 1 })
      return [
        `Morning brief for ${range.from.slice(0, 10)}`,
        `calendarEvents: ${events.items.length}`,
        `openTasks: ${tasks.items.filter((item) => item.status === 'open').length}`,
        `knowledgeHits: ${notes?.hits.length ?? 0}`,
      ].join('\n')
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
