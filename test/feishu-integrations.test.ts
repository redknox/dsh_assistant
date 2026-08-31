import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildFeishuCliArgv,
  createFeishuContactsProvider,
  createFeishuMailProvider,
  inspectFeishuCli,
  type FeishuCliRunner,
} from '../src/adapters/integrations/feishu-cli.js'
import { createFeishuCalendarProvider } from '../src/adapters/integrations/feishu-calendar.js'
import { createFeishuMeetingNotesProvider } from '../src/adapters/integrations/feishu-meeting-notes.js'

class StubRunner implements FeishuCliRunner {
  readonly calls: string[][] = []

  constructor(private readonly replies: unknown[]) {}

  async run(args: readonly string[]): Promise<unknown> {
    this.calls.push([...args])
    return this.replies.shift()
  }
}

describe('Feishu read-only integrations', () => {
  it('pins host calls to a validated least-privilege CLI profile', () => {
    assert.deepEqual(buildFeishuCliArgv(['auth', 'status', '--json'], 'tars-ng'), [
      '--profile', 'tars-ng', 'auth', 'status', '--json',
    ])
    assert.throws(() => buildFeishuCliArgv(['auth', 'status'], '--help'), /profile name is invalid/)
  })

  it('requires the exact scopes before a Feishu profile is considered available', async () => {
    const runner = new StubRunner([{
      ok: true,
      data: { identities: { user: { status: 'ready', scope: 'calendar:calendar.event:read' } } },
    }])
    assert.deepEqual(await inspectFeishuCli(runner, [
      'calendar:calendar.event:read',
      'calendar:calendar.free_busy:read',
    ]), {
      available: false,
      configured: true,
      reason: 'Feishu profile is missing required scopes: calendar:calendar.free_busy:read',
    })
  })

  it('maps Feishu agenda, detail, freebusy, and confirmed create into the calendar seam', async () => {
    const runner = new StubRunner([
      { ok: true, data: [{ event_id: 'e1', summary: 'Review', start_time: { datetime: '2026-08-28T10:00:00+08:00', timezone: 'Asia/Shanghai' }, end_time: { datetime: '2026-08-28T11:00:00+08:00', timezone: 'Asia/Shanghai' } }] },
      { ok: true, data: { event: {
        event_id: 'e1',
        summary: 'Review',
        start_time: { date: '2026-08-28' },
        end_time: { date: '2026-08-29' },
        description_rich: '**Agenda**',
        event_organizer: { user_id: 'ou_owner', display_name: 'Owner' },
        attendees: [
          { attendee_id: 'a1', user_id: 'ou_owner', display_name: 'Owner', type: 'user', rsvp_status: 'accept', is_organizer: true },
          { attendee_id: 'a2', room_id: 'omm_room', display_name: 'Mission Room', type: 'resource', rsvp_status: 'accept', is_organizer: false },
        ],
        has_more_attendee: false,
        reminders: [{ minutes: 5 }],
        self_rsvp_status: 'accept',
        free_busy_status: 'busy',
        attendee_ability: 'can_invite_others',
        vchat: { vc_type: 'vc', meeting_url: 'https://vc.example.test/j/1' },
        app_link: 'https://example.test/event/1',
        visibility: 'default',
        location: { name: 'Mission Room', address: 'Deck 2' },
        attachments: [],
      } } },
      { ok: true, data: [{ start_time: '2026-08-28T10:00:00+08:00', end_time: '2026-08-28T11:00:00+08:00' }] },
      { ok: true, data: { event: { event_id: 'e2', summary: 'Focus', start: '2026-08-29T10:00:00+08:00', end: '2026-08-29T10:30:00+08:00' } } },
    ])
    const calendar = createFeishuCalendarProvider({ runner, allowCreate: true })

    const agenda = await calendar.listEvents({ from: '2026-08-28T00:00:00+08:00', to: '2026-08-29T00:00:00+08:00' })
    assert.equal(agenda.items[0]?.id, 'e1')
    assert.equal(agenda.items[0]?.start, '2026-08-28T10:00:00+08:00')
    assert.equal(agenda.items[0]?.timeZone, 'Asia/Shanghai')
    assert.deepEqual(await calendar.getEvent('e1'), {
      id: 'e1',
      title: 'Review',
      start: '2026-08-28',
      end: '2026-08-29',
      calendarId: 'primary',
      description: '**Agenda**',
      attendees: ['Owner', 'Mission Room'],
      attendeeDetails: [
        { id: 'ou_owner', displayName: 'Owner', type: 'user', rsvpStatus: 'accept', organizer: true },
        { id: 'omm_room', displayName: 'Mission Room', type: 'resource', rsvpStatus: 'accept', organizer: false },
      ],
      hasMoreAttendees: false,
      allDay: true,
      organizer: { id: 'ou_owner', displayName: 'Owner' },
      location: { name: 'Mission Room', address: 'Deck 2' },
      reminders: [{ minutesBeforeStart: 5 }],
      selfRsvpStatus: 'accept',
      freeBusyStatus: 'busy',
      attendeeAbility: 'can_invite_others',
      conference: { type: 'vc', meetingUrl: 'https://vc.example.test/j/1' },
      appLink: 'https://example.test/event/1',
      visibility: 'default',
      attachments: [],
    })
    assert.equal((await calendar.freeBusy({ from: '2026-08-28T00:00:00+08:00', to: '2026-08-29T00:00:00+08:00' })).items[0]?.busy, true)

    const created = await calendar.createEvent({
      title: 'Focus',
      start: '2026-08-29T10:00:00+08:00',
      end: '2026-08-29T10:30:00+08:00',
      attendees: ['ou_1'],
      description: 'Deep work',
      idempotencyKey: 'op-1',
    })
    assert.equal(created.id, 'e2')
    assert.equal((await calendar.createEvent({
      title: 'Focus',
      start: '2026-08-29T10:00:00+08:00',
      end: '2026-08-29T10:30:00+08:00',
      idempotencyKey: 'op-1',
    })).id, 'e2')
    assert.equal(runner.calls.length, 4)
    assert.deepEqual(runner.calls[3], [
      'calendar', '+create', '--summary', 'Focus', '--start', '2026-08-29T10:00:00+08:00',
      '--end', '2026-08-29T10:30:00+08:00', '--calendar-id', 'primary', '--as', 'user', '--format', 'json',
      '--description', 'Deep work', '--attendee-ids', 'ou_1',
    ])
    assert.deepEqual(runner.calls[1], [
      'calendar', 'events', 'get', '--calendar-id', 'primary', '--event-id', 'e1',
      '--need-attendee', '--max-attendee-num', '100', '--user-id-type', 'open_id',
      '--as', 'user', '--format', 'json',
    ])
  })

  it('keeps omitted Feishu detail fields unknown instead of converting them to empty values', async () => {
    const runner = new StubRunner([{ ok: true, data: { event_id: 'e1', summary: 'Private', start_time: '2026-08-28T10:00:00+08:00', end_time: '2026-08-28T11:00:00+08:00' } }])
    const event = await createFeishuCalendarProvider({ runner }).getEvent('e1')

    assert.equal(Object.hasOwn(event, 'attendees'), false)
    assert.equal(Object.hasOwn(event, 'attachments'), false)
    assert.equal(Object.hasOwn(event, 'reminders'), false)
    assert.equal(Object.hasOwn(event, 'organizer'), false)
  })

  it('resolves and reads bounded AI meeting notes through the calendar-to-document chain', async () => {
    const chain = [
      { ok: true, data: { meetings: [{ event_id: 'e1', meeting_id: 'm1' }] } },
      { ok: true, data: [{ meeting_id: 'm1', topic: 'Review', note_id: 'n1', minute_token: 'min1' }] },
      { ok: true, data: { note: { note_display_type: 'normal', note_doc_token: 'doc1', verbatim_doc_token: 'verb1', shared_doc_tokens: ['shared1'] } } },
    ]
    const runner = new StubRunner([
      ...chain,
      ...chain,
      { ok: true, data: { document: { content: '# Review\nDecisions' } } },
    ])
    const notes = createFeishuMeetingNotesProvider({ runner })

    assert.deepEqual(await notes.inspect('e1'), {
      calendarEventId: 'e1',
      meetingId: 'm1',
      topic: 'Review',
      aiNotesAvailable: true,
      transcriptAvailable: true,
      minutesAvailable: true,
      noteDisplayType: 'normal',
      sharedDocumentCount: 1,
    })
    assert.deepEqual(await notes.readAiNotes('e1', { maxChars: 8 }), {
      calendarEventId: 'e1',
      meetingId: 'm1',
      topic: 'Review',
      aiNotesAvailable: true,
      transcriptAvailable: true,
      minutesAvailable: true,
      noteDisplayType: 'normal',
      sharedDocumentCount: 1,
      content: '# Review',
      truncated: true,
    })
    assert.deepEqual(runner.calls.at(-1), [
      'docs', '+fetch', '--doc', 'doc1', '--doc-format', 'markdown', '--detail', 'simple',
      '--as', 'user', '--format', 'json',
    ])
  })

  it('maps mail triage and message detail without exposing a generic shell', async () => {
    const runner = new StubRunner([
      { ok: true, data: { messages: [{ message_id: 'm1', from: 'Ada <ada@example.com>', subject: 'Review', snippet: 'Please review' }], next_page_token: 'next' } },
      { ok: true, data: { message_id: 'm1', from: 'Ada <ada@example.com>', subject: 'Review', snippet: 'Please review', body_text: 'Full body' } },
    ])
    const mail = createFeishuMailProvider({ runner })

    assert.deepEqual(await mail.listMessages({ query: 'review', limit: 5 }), {
      items: [{ id: 'm1', from: 'Ada <ada@example.com>', subject: 'Review', snippet: 'Please review' }],
      nextCursor: 'next',
    })
    assert.equal((await mail.getMessage('m1')).body, 'Full body')
    assert.deepEqual(runner.calls, [
      ['mail', '+triage', '--mailbox', 'me', '--max', '5', '--as', 'user', '--format', 'json', '--query', 'review'],
      ['mail', '+message', '--mailbox', 'me', '--message-id', 'm1', '--html=false', '--as', 'user', '--format', 'json'],
    ])
  })

  it('keeps personal mail contacts and enterprise directory search distinct', async () => {
    const runner = new StubRunner([
      { ok: true, data: { items: [{ id: 'c1', name: 'Ada', mail_address: 'ada@example.com' }], page_token: 'p2' } },
      { ok: true, data: { users: [{ open_id: 'ou_1', name: 'Bob', email: 'bob@example.com' }] } },
    ])
    const contacts = createFeishuContactsProvider({ runner })

    assert.deepEqual(await contacts.listContacts({ limit: 20 }), {
      items: [{ id: 'c1', name: 'Ada', email: 'ada@example.com', source: 'mail-contact' }],
      nextCursor: 'p2',
    })
    assert.deepEqual(await contacts.listContacts({ query: 'Bob', limit: 10 }), {
      items: [{ id: 'ou_1', name: 'Bob', email: 'bob@example.com', source: 'directory' }],
    })
    assert.deepEqual(runner.calls[0], ['mail', 'user_mailbox.mail_contacts', 'list', '--user-mailbox-id', 'me', '--page-size', '20', '--as', 'user', '--format', 'json'])
    assert.deepEqual(runner.calls[1], ['contact', '+search-user', '--query', 'Bob', '--page-size', '10', '--as', 'user', '--format', 'json'])
  })
})
