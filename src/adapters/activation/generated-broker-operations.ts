import type { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import { scanObsidianVault } from '../knowledge/obsidian-vault.js'
import { createGoogleCalendarProvider } from '../integrations/google-calendar.js'
import {
  GeneratedBrokerError,
  GeneratedHostBroker,
  HOST_KNOWLEDGE_RETRIEVE,
  HOST_GOOGLE_CALENDAR_MUTATE,
  HOST_GOOGLE_CALENDAR_READ,
  HOST_OBSIDIAN_MUTATE,
  HOST_OBSIDIAN_READ,
  textEchoBrokerOperation,
  type GeneratedBrokerOperation,
} from '../../domain/generated-runtime/index.js'

const MAX_QUERY_BYTES = 2 * 1024
const MAX_HITS = 5

function onlyKeys(args: Readonly<Record<string, unknown>>, allowed: readonly string[], capability: string): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new GeneratedBrokerError(`${capability} received an unknown argument`)
  }
}

function requiredString(args: Readonly<Record<string, unknown>>, key: string, capability: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new GeneratedBrokerError(`${capability} ${key} must be a non-empty string`)
  return value
}

function knowledgeOperation(ctx: Context): GeneratedBrokerOperation {
  return {
    capability: HOST_KNOWLEDGE_RETRIEVE,
    execute(args, execution) {
      execution.signal.throwIfAborted()
      if (Object.keys(args).some((key) => key !== 'query' && key !== 'limit')) {
        throw new GeneratedBrokerError('host.knowledge.retrieve received an unknown argument')
      }
      if (typeof args.query !== 'string' || args.query.trim() === '') {
        throw new GeneratedBrokerError('host.knowledge.retrieve query must be a non-empty string')
      }
      if (Buffer.byteLength(args.query, 'utf8') > MAX_QUERY_BYTES) {
        throw new GeneratedBrokerError(`host.knowledge.retrieve query exceeds the ${MAX_QUERY_BYTES}-byte limit`)
      }
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > MAX_HITS)) {
        throw new GeneratedBrokerError(`host.knowledge.retrieve limit must be an integer from 1 to ${MAX_HITS}`)
      }
      const knowledge = ctx.get('personalKnowledge')
      if (!knowledge) throw new GeneratedBrokerError('host.knowledge.retrieve is unavailable')
      const result = knowledge.retrieve({ text: args.query, limit: args.limit === undefined ? undefined : Number(args.limit) })
      return {
        why: result.trace.why,
        hits: result.hits.map((hit) => ({
          citation: hit.citation,
          score: hit.score,
          reasons: hit.reasons,
        })),
      }
    },
  }
}

function googleCalendarReadOperation(ctx: Context): GeneratedBrokerOperation {
  return {
    capability: HOST_GOOGLE_CALENDAR_READ,
    async execute(args, execution) {
      execution.signal.throwIfAborted()
      onlyKeys(args, ['operation', 'method', 'path', 'body'], HOST_GOOGLE_CALENDAR_READ)
      const integrations = ctx.get('integrations')
      if (!integrations) throw new GeneratedBrokerError(`${HOST_GOOGLE_CALENDAR_READ} is unavailable`)
      if (args.operation === 'status') {
        const transport = integrations.googleCalendarTransport
        return {
          provider: 'google',
          transport: 'host-managed',
          credential: typeof transport.credentialState === 'function' ? transport.credentialState() : 'injected',
        }
      }
      if (args.operation !== 'request') throw new GeneratedBrokerError(`${HOST_GOOGLE_CALENDAR_READ} operation is unsupported`)
      const method = requiredString(args, 'method', HOST_GOOGLE_CALENDAR_READ)
      const requestPath = requiredString(args, 'path', HOST_GOOGLE_CALENDAR_READ)
      const readOnly = method === 'GET' || (method === 'POST' && requestPath === '/calendar/v3/freeBusy')
      if (!readOnly) throw new GeneratedBrokerError(`${HOST_GOOGLE_CALENDAR_READ} permits only GET and freeBusy requests`)
      return integrations.googleCalendarTransport.request({
        method: method as 'GET' | 'POST',
        path: requestPath,
        ...(args.body === undefined ? {} : { body: args.body }),
      }, execution.signal)
    },
  }
}

function googleCalendarMutateOperation(ctx: Context): GeneratedBrokerOperation {
  return {
    capability: HOST_GOOGLE_CALENDAR_MUTATE,
    execute(args, execution) {
      execution.signal.throwIfAborted()
      onlyKeys(args, ['operation', 'event'], HOST_GOOGLE_CALENDAR_MUTATE)
      if (args.operation !== 'create' || args.event === null || typeof args.event !== 'object' || Array.isArray(args.event)) {
        throw new GeneratedBrokerError(`${HOST_GOOGLE_CALENDAR_MUTATE} requires one event create request`)
      }
      const policy = ctx.get('actionPolicy')?.policy
      if (!policy) throw new GeneratedBrokerError(`${HOST_GOOGLE_CALENDAR_MUTATE} policy is unavailable`)
      const integrations = ctx.get('integrations')
      if (!integrations) throw new GeneratedBrokerError(`${HOST_GOOGLE_CALENDAR_MUTATE} is unavailable`)
      policy.registerExecutor('generated-google-calendar', 'create_event', (payload, signal) => createGoogleCalendarProvider({
        transport: integrations.googleCalendarTransport,
        allowCreate: true,
      }).createEvent({
        title: String(payload.title ?? ''),
        start: String(payload.start ?? ''),
        end: String(payload.end ?? ''),
        timeZone: typeof payload.timeZone === 'string' ? payload.timeZone : undefined,
        calendarId: typeof payload.calendarId === 'string' ? payload.calendarId : undefined,
        description: typeof payload.description === 'string' ? payload.description : undefined,
        attendees: Array.isArray(payload.attendees) ? payload.attendees.map(String) : undefined,
        idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined,
      }, signal))
      return policy.apply({
        capability: 'generated-google-calendar',
        operation: 'create_event',
        intent: 'execute',
        payload: args.event as Record<string, unknown>,
        authorityScope: execution.candidateId,
        signal: execution.signal,
      })
    },
  }
}

function obsidianReadOperation(ctx: Context): GeneratedBrokerOperation {
  return {
    capability: HOST_OBSIDIAN_READ,
    execute(args, execution) {
      execution.signal.throwIfAborted()
      onlyKeys(args, ['operation', 'path'], HOST_OBSIDIAN_READ)
      const access = ctx.get('obsidianVault')?.access
      if (!access) throw new GeneratedBrokerError(`${HOST_OBSIDIAN_READ} is unavailable`)
      const notes = scanObsidianVault(access.root)
      const rows = notes.map((note) => ({
        id: path.relative(access.root, note.sourceUri).split(path.sep).join('/'),
        text: note.text,
      }))
      if (args.operation === 'list') return { items: rows.map((item) => item.id) }
      if (args.operation === 'read') {
        const notePath = requiredString(args, 'path', HOST_OBSIDIAN_READ)
        const note = rows.find((item) => item.id === notePath)
        if (!note) throw new GeneratedBrokerError('Obsidian note is outside the configured Vault or does not exist')
        return note
      }
      throw new GeneratedBrokerError(`${HOST_OBSIDIAN_READ} operation is unsupported`)
    },
  }
}

function obsidianMutateOperation(ctx: Context): GeneratedBrokerOperation {
  return {
    capability: HOST_OBSIDIAN_MUTATE,
    execute(args, execution) {
      execution.signal.throwIfAborted()
      onlyKeys(args, ['operation', 'path', 'content'], HOST_OBSIDIAN_MUTATE)
      if (args.operation !== 'create') throw new GeneratedBrokerError(`${HOST_OBSIDIAN_MUTATE} operation is unsupported`)
      const notePath = requiredString(args, 'path', HOST_OBSIDIAN_MUTATE)
      const content = requiredString(args, 'content', HOST_OBSIDIAN_MUTATE)
      const policy = ctx.get('actionPolicy')?.policy
      if (!policy) throw new GeneratedBrokerError(`${HOST_OBSIDIAN_MUTATE} policy is unavailable`)
      return policy.apply({
        capability: 'obsidian',
        operation: 'create_note',
        intent: 'execute',
        payload: { path: notePath, content },
        authorityScope: execution.candidateId,
        signal: execution.signal,
      })
    },
  }
}

/** Product adapter set for the host-owned generated capability Broker seam. */
export function createGeneratedHostBroker(ctx: Context): GeneratedHostBroker {
  return new GeneratedHostBroker([
    textEchoBrokerOperation,
    knowledgeOperation(ctx),
    googleCalendarReadOperation(ctx),
    googleCalendarMutateOperation(ctx),
    obsidianReadOperation(ctx),
    obsidianMutateOperation(ctx),
  ])
}
