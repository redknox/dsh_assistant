import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eventIdFromOperation } from '../src/google-event.js'
import { createGoogleCalendarProvider } from '../src/provider.js'
import { sanitizeProviderError } from '../src/sanitize.js'
import { assertCalendarRange } from '../src/time.js'
import { createFakeGoogleCalendarTransport } from './fake-transport.js'

describe('google calendar candidate', () => {
  it('requires a host-managed transport and does not default to a private HTTP client', () => {
    assert.throws(() => createGoogleCalendarProvider({ allowCreate: false }), /host-managed Google Calendar transport is required/)
  })

  it('proposes without mutating the Google store', async () => {
    const transport = createFakeGoogleCalendarTransport()
    const provider = createGoogleCalendarProvider({ transport, allowCreate: false })
    const before = transport.events.length
    const proposal = await provider.proposeCreateEvent({
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
      calendarId: 'primary',
      attendees: ['ada@example.com'],
    })
    assert.equal(proposal.trust, 'propose')
    assert.equal(transport.events.length, before)
  })

  it('denies create on the read-only candidate', async () => {
    const provider = createGoogleCalendarProvider({ transport: createFakeGoogleCalendarTransport(), allowCreate: false })
    await assert.rejects(() => provider.createEvent({
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
    }), /not authorized/)
  })

  it('reconciles after the create signal aborts once the remote insert succeeded', async () => {
    const remote = []
    const methods = []
    const controller = new AbortController()
    const transport = {
      async request(input, signal) {
        if (signal?.aborted) {
          const error = new Error('timeout')
          error.code = 'cancelled'
          throw error
        }
        methods.push(input.method)
        if (input.method === 'POST') {
          remote.push(input.body)
          controller.abort()
          const error = new Error('timeout')
          error.code = 'cancelled'
          throw error
        }
        const found = remote.find((event) => event.id === decodeURIComponent(String(input.path).split('/').pop()))
        return found === undefined
          ? { status: 404, body: { error: { message: 'not found' } } }
          : { status: 200, body: found }
      },
    }
    const event = await createGoogleCalendarProvider({ transport, allowCreate: true }).createEvent({
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
      idempotencyKey: 'op-abort-1',
    }, controller.signal)
    assert.equal(event.id, eventIdFromOperation('op-abort-1'))
    assert.equal(remote.length, 1)
    assert.deepEqual(methods, ['GET', 'POST', 'GET'])
  })

  it('keeps a pre-success timeout failed and does not POST again', async () => {
    const methods = []
    const transport = createFakeGoogleCalendarTransport({ seed: [], failNextCreate: 'timeout-before-success' })
    const original = transport.request.bind(transport)
    transport.request = async (input, signal) => {
      methods.push(input.method)
      return original(input, signal)
    }
    await assert.rejects(() => createGoogleCalendarProvider({ transport, allowCreate: true }).createEvent({
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
      idempotencyKey: 'op-abort-miss',
    }), /timeout/)
    assert.deepEqual(methods, ['GET', 'POST', 'GET'])
    assert.equal(transport.events.length, 0)
  })

  it('reconciles a timeout after remote create using the deterministic event id', async () => {
    const transport = createFakeGoogleCalendarTransport({ seed: [], failNextCreate: 'timeout-after-success' })
    const provider = createGoogleCalendarProvider({ transport, allowCreate: true })
    const input = {
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
      idempotencyKey: 'op-focus-1',
    }
    const first = await provider.createEvent(input)
    const second = await provider.createEvent(input)
    assert.equal(first.id, eventIdFromOperation('op-focus-1'))
    assert.equal(first.id, second.id)
    assert.equal(transport.events.filter((event) => event.summary === 'Focus').length, 1)
  })

  it('sanitizes credential-bearing provider errors', async () => {
    const provider = createGoogleCalendarProvider({ transport: createFakeGoogleCalendarTransport() })
    await assert.rejects(async () => {
      await provider.getEvent('unauthorized')
    }, (error) => {
      assert.match(error.message, /redacted/)
      assert.doesNotMatch(error.message, /leaked-credential/)
      assert.doesNotMatch(error.message, /Bearer /)
      return true
    })
  })

  it('rejects vague timed ranges and preserves all-day / DST bounds', () => {
    assert.throws(() => assertCalendarRange({ start: '2026-03-08T01:30', end: '2026-03-08T03:30' }))
    assertCalendarRange({ start: '2026-08-22', end: '2026-08-23', allDay: true })
    assertCalendarRange({
      start: '2026-03-08T06:30:00.000Z',
      end: '2026-03-08T07:30:00.000Z',
      timeZone: 'America/New_York',
    })
    assert.match(sanitizeProviderError('Authorization: Bearer ya29.secret-token'), /redacted/)
  })
})
