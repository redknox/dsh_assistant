import { execFile } from 'node:child_process'
import type { Contact, ContactsProvider, MailMessage, MailMessageDetail, MailProvider } from '../../domain/integrations/hub.js'
import { IntegrationError, type Availability, type Page } from '../../domain/integrations/types.js'

export interface FeishuCliRunner {
  run(args: readonly string[], signal?: AbortSignal): Promise<unknown>
}

type JsonObject = Record<string, unknown>

export const FEISHU_MAIL_CONTACT_SCOPES = [
  'mail:user_mailbox.message:readonly',
  'mail:user_mailbox.message.address:read',
  'mail:user_mailbox.message.subject:read',
  'mail:user_mailbox.message.body:read',
  'mail:user_mailbox.mail_contact:read',
  'contact:user:search',
] as const

export const FEISHU_CALENDAR_SCOPES = [
  'calendar:calendar.event:read',
  'calendar:calendar.free_busy:read',
  'calendar:calendar.event:create',
  'calendar:calendar.event:update',
] as const

export const FEISHU_MEETING_NOTES_SCOPES = [
  'calendar:calendar.event:read',
  'vc:meeting.meetingevent:read',
  'vc:record:readonly',
  'docx:document:readonly',
] as const

const ALLOWED = [
  ['auth', 'status'],
  ['calendar', '+agenda'],
  ['calendar', 'events', 'get'],
  ['calendar', '+freebusy'],
  ['calendar', '+create'],
  ['calendar', '+meeting'],
  ['vc', '+detail'],
  ['note', '+detail'],
  ['docs', '+fetch'],
  ['mail', '+triage'],
  ['mail', '+message'],
  ['mail', 'user_mailbox.mail_contacts', 'list'],
  ['contact', '+search-user'],
] as const

export function createHostFeishuCliRunner(options: { profile?: string } = {}): FeishuCliRunner {
  return {
    run(args, signal) {
      if (!ALLOWED.some((prefix) => prefix.every((part, index) => args[index] === part))) {
        return Promise.reject(new IntegrationError('mail', 'invalid_request', 'Feishu CLI operation is not allowlisted'))
      }
      const argv = buildFeishuCliArgv(args, options.profile)
      return new Promise((resolve, reject) => {
        execFile('lark-cli', argv, {
          encoding: 'utf8',
          maxBuffer: 2 * 1024 * 1024,
          timeout: 15_000,
          signal,
          env: {
            ...process.env,
            LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
            LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
          },
        }, (error, stdout, stderr) => {
          const decoded = decodeJson(stdout || stderr)
          if (error || !isObject(decoded) || decoded.ok === false) {
            const detail = isObject(decoded) && isObject(decoded.error) && typeof decoded.error.message === 'string'
              ? decoded.error.message
              : 'Feishu CLI is unavailable or not authorized'
            reject(new IntegrationError(capabilityOfArgs(args), 'unavailable', detail.slice(0, 500)))
            return
          }
          resolve(decoded)
        })
      })
    },
  }
}

export function buildFeishuCliArgv(args: readonly string[], profile?: string): string[] {
  if (profile === undefined) return [...args]
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new IntegrationError('mail', 'invalid_request', 'Feishu CLI profile name is invalid')
  }
  return ['--profile', profile, ...args]
}

export async function inspectFeishuCli(runner: FeishuCliRunner, requiredScopes: readonly string[] = []): Promise<Availability> {
  try {
    const result = dataOf(await runner.run(['auth', 'status', '--json', '--verify']))
    const identities = objectOf(result.identities)
    const user = objectOf(identities.user)
    if (user.status === 'authenticated' || user.status === 'logged-in' || user.status === 'ready' || user.verified === true || result.verified === true) {
      const granted = new Set((stringOf(user.scope) ?? '').split(/\s+/).filter(Boolean))
      const missing = requiredScopes.filter((scope) => !granted.has(scope))
      if (missing.length > 0) {
        return { available: false, configured: true, reason: `Feishu profile is missing required scopes: ${missing.join(', ')}` }
      }
      return { available: true, configured: true, provider: 'feishu' }
    }
    return { available: false, configured: true, reason: 'Feishu user authorization is unavailable' }
  } catch (error) {
    return { available: false, configured: true, reason: safeMessage(error) }
  }
}

export function createFeishuMailProvider(options: { runner: FeishuCliRunner }): MailProvider {
  return {
    capability: 'mail',
    availability: () => ({ available: true, configured: true, provider: 'feishu' }),
    async listMessages(query): Promise<Page<MailMessage>> {
      const args = ['mail', '+triage', '--mailbox', 'me', '--max', String(boundLimit(query.limit)), '--as', 'user', '--format', 'json']
      if (query.query) args.push('--query', query.query)
      if (query.cursor) args.push('--page-token', query.cursor)
      const data = dataOf(await options.runner.run(args, query.signal))
      const rows = arrayOf(data.messages ?? data.items)
      const items = rows.map(mailSummary)
      const nextCursor = stringOf(data.next_page_token ?? data.page_token)
      return nextCursor ? { items, nextCursor } : { items }
    },
    async getMessage(id, signal): Promise<MailMessageDetail> {
      if (!id) throw new IntegrationError('mail', 'invalid_request', 'message id is required')
      const data = dataOf(await options.runner.run([
        'mail', '+message', '--mailbox', 'me', '--message-id', id, '--html=false', '--as', 'user', '--format', 'json',
      ], signal))
      const summary = mailSummary(data)
      return { ...summary, id: summary.id || id, body: stringOf(data.body_text ?? data.text ?? data.body) ?? '' }
    },
  }
}

export function createFeishuContactsProvider(options: { runner: FeishuCliRunner }): ContactsProvider {
  return {
    capability: 'contacts',
    availability: () => ({ available: true, configured: true, provider: 'feishu' }),
    async listContacts(query): Promise<Page<Contact>> {
      if (query.query) {
        const data = dataOf(await options.runner.run([
          'contact', '+search-user', '--query', query.query, '--page-size', String(boundLimit(query.limit)), '--as', 'user', '--format', 'json',
        ], query.signal))
        return { items: arrayOf(data.users ?? data.items).map((row) => contactOf(row, 'directory')) }
      }
      const args = ['mail', 'user_mailbox.mail_contacts', 'list', '--user-mailbox-id', 'me', '--page-size', String(boundLimit(query.limit)), '--as', 'user', '--format', 'json']
      if (query.cursor) args.push('--page-token', query.cursor)
      const data = dataOf(await options.runner.run(args, query.signal))
      const items = arrayOf(data.items).map((row) => contactOf(row, 'mail-contact'))
      const nextCursor = stringOf(data.page_token)
      return nextCursor ? { items, nextCursor } : { items }
    },
  }
}

function mailSummary(value: unknown): MailMessage {
  const row = objectOf(value)
  return {
    id: stringOf(row.message_id ?? row.id) ?? '',
    from: addressOf(row.from ?? row.sender),
    subject: stringOf(row.subject) ?? '',
    snippet: stringOf(row.snippet ?? row.preview ?? row.body_preview) ?? '',
  }
}

function contactOf(value: unknown, source: Contact['source']): Contact {
  const row = objectOf(value)
  return {
    id: stringOf(row.open_id ?? row.id ?? row.user_id) ?? '',
    name: stringOf(row.name ?? row.localized_name) ?? '',
    ...(stringOf(row.email ?? row.mail_address) ? { email: stringOf(row.email ?? row.mail_address)! } : {}),
    source,
  }
}

function addressOf(value: unknown): string {
  if (typeof value === 'string') return value
  const row = objectOf(value)
  return stringOf(row.address ?? row.email ?? row.name) ?? ''
}

function boundLimit(value: number | undefined): number {
  if (value === undefined) return 20
  if (!Number.isInteger(value) || value < 1) throw new IntegrationError('mail', 'invalid_request', 'limit must be a positive integer')
  return Math.min(value, 20)
}

function dataOf(value: unknown): JsonObject {
  const root = objectOf(value)
  if (root.ok === false) throw new IntegrationError('mail', 'unavailable', 'Feishu request was not authorized')
  return isObject(root.data) ? root.data : root
}

function objectOf(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Feishu CLI is unavailable'
}

function capabilityOfArgs(args: readonly string[]): 'calendar' | 'mail' | 'contacts' {
  if (args[0] === 'calendar') return 'calendar'
  if (args[0] === 'contact') return 'contacts'
  return 'mail'
}
