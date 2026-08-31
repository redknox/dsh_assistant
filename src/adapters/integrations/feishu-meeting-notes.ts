import { IntegrationError } from '../../domain/integrations/types.js'
import type { FeishuCliRunner } from './feishu-cli.js'

type JsonObject = Record<string, unknown>

export interface MeetingArtifacts {
  readonly calendarEventId: string
  readonly meetingId: string
  readonly topic?: string
  readonly aiNotesAvailable: boolean
  readonly transcriptAvailable: boolean
  readonly minutesAvailable: boolean
  readonly noteDisplayType?: string
  readonly sharedDocumentCount: number
}

export interface MeetingAiNotes extends MeetingArtifacts {
  /** Provider-generated AI notes in Markdown; not an independent TARS-NG analysis. */
  readonly content: string
  readonly truncated: boolean
}

export interface MeetingNotesProvider {
  inspect(calendarEventId: string, signal?: AbortSignal): Promise<MeetingArtifacts>
  readAiNotes(calendarEventId: string, options?: { readonly maxChars?: number; readonly signal?: AbortSignal }): Promise<MeetingAiNotes>
}

export function createFeishuMeetingNotesProvider(options: { readonly runner: FeishuCliRunner }): MeetingNotesProvider {
  async function resolve(calendarEventId: string, signal?: AbortSignal) {
    if (!calendarEventId) throw new IntegrationError('calendar', 'invalid_request', 'calendar event id is required')
    const calendarData = payloadOf(await options.runner.run([
      'calendar', '+meeting', '--event-ids', calendarEventId, '--calendar-id', 'primary',
      '--as', 'user', '--format', 'json',
    ], signal))
    const meeting = rowsOf(calendarData, ['meetings'])[0]
    const meetingId = stringOf(objectOf(meeting).meeting_id)
    if (!meetingId) throw new IntegrationError('calendar', 'unavailable', 'calendar event has no accessible Feishu meeting')

    const meetingData = payloadOf(await options.runner.run([
      'vc', '+detail', '--meeting-ids', meetingId, '--as', 'user', '--format', 'json',
    ], signal))
    const meetingDetail = objectOf(rowsOf(meetingData, ['meetings'])[0])
    const noteId = stringOf(meetingDetail.note_id)
    const minuteToken = stringOf(meetingDetail.minute_token)
    if (!noteId) {
      return {
        artifacts: {
          calendarEventId,
          meetingId,
          ...(stringOf(meetingDetail.topic) ? { topic: stringOf(meetingDetail.topic)! } : {}),
          aiNotesAvailable: false,
          transcriptAvailable: false,
          minutesAvailable: Boolean(minuteToken),
          sharedDocumentCount: 0,
        } satisfies MeetingArtifacts,
      }
    }

    const noteData = objectOf(payloadOf(await options.runner.run([
      'note', '+detail', '--note-id', noteId, '--as', 'user', '--format', 'json',
    ], signal)))
    const note = objectOf(noteData.note ?? noteData)
    const documentToken = stringOf(note.note_doc_token)
    const displayType = stringOf(note.note_display_type)
    const verbatimToken = stringOf(note.verbatim_doc_token)
    return {
      documentToken,
      artifacts: {
        calendarEventId,
        meetingId,
        ...(stringOf(meetingDetail.topic) ? { topic: stringOf(meetingDetail.topic)! } : {}),
        aiNotesAvailable: Boolean(documentToken),
        transcriptAvailable: displayType === 'unified' || Boolean(verbatimToken),
        minutesAvailable: Boolean(minuteToken),
        ...(displayType ? { noteDisplayType: displayType } : {}),
        sharedDocumentCount: arrayOf(note.shared_doc_tokens).length,
      } satisfies MeetingArtifacts,
    }
  }

  return {
    async inspect(calendarEventId, signal) {
      return (await resolve(calendarEventId, signal)).artifacts
    },
    async readAiNotes(calendarEventId, readOptions = {}) {
      const resolved = await resolve(calendarEventId, readOptions.signal)
      if (!resolved.documentToken) throw new IntegrationError('calendar', 'unavailable', 'meeting has no accessible AI notes document')
      const data = objectOf(payloadOf(await options.runner.run([
        'docs', '+fetch', '--doc', resolved.documentToken, '--doc-format', 'markdown', '--detail', 'simple',
        '--as', 'user', '--format', 'json',
      ], readOptions.signal)))
      const document = objectOf(data.document ?? data)
      const content = stringOf(document.content) ?? ''
      const maxChars = boundMaxChars(readOptions.maxChars)
      return {
        ...resolved.artifacts,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
      }
    },
  }
}

function boundMaxChars(value: number | undefined): number {
  if (value === undefined) return 20_000
  if (!Number.isInteger(value) || value < 1) throw new IntegrationError('calendar', 'invalid_request', 'maxChars must be a positive integer')
  return Math.min(value, 50_000)
}

function payloadOf(value: unknown): unknown {
  const root = objectOf(value)
  if (root.ok === false) throw new IntegrationError('calendar', 'unavailable', 'Feishu meeting notes request was not authorized')
  return root.data ?? value
}

function rowsOf(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value
  const object = objectOf(value)
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key] as unknown[]
  }
  return []
}

function objectOf(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
