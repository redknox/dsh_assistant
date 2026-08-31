import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { WebUiHttpTransport } from '../src/product/web-ui-http.js'

interface CapturedResponse {
  readonly response: ServerResponse
  readonly writes: string[]
  readonly ends: string[]
  readonly status: () => number | undefined
  readonly headers: () => Record<string, string>
}

function capturedResponse(): CapturedResponse {
  let responseStatus: number | undefined
  let responseHeaders: Record<string, string> = {}
  const writes: string[] = []
  const ends: string[] = []
  const response = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      responseStatus = status
      responseHeaders = headers
      return this
    },
    write(chunk: unknown) {
      writes.push(String(chunk))
      return true
    },
    end(chunk?: unknown) {
      ends.push(chunk === undefined ? '' : String(chunk))
      return this
    },
  } as unknown as ServerResponse
  return {
    response,
    writes,
    ends,
    status: () => responseStatus,
    headers: () => responseHeaders,
  }
}

function requestBody(value: Buffer | string): IncomingMessage {
  return Readable.from([value]) as unknown as IncomingMessage
}

describe('Web UI HTTP transport', () => {
  it('issues a private session cookie and authenticates only mutating requests that return it', () => {
    const transport = new WebUiHttpTransport(undefined, () => ({ ok: true }))
    const captured = capturedResponse()
    transport.sendJson(captured.response, 200, { ok: true }, true)
    assert.equal(captured.status(), 200)
    assert.equal(captured.ends[0], '{"ok":true}')
    const cookie = captured.headers()['set-cookie']
    assert.match(cookie ?? '', /^tars_ng_ui=/)
    assert.equal(transport.mutationTrusted('GET', undefined), true)
    assert.equal(transport.mutationTrusted('POST', undefined), false)
    assert.equal(transport.mutationTrusted('POST', cookie), true)
  })

  it('parses bounded JSON and rejects oversized request bodies', async () => {
    const transport = new WebUiHttpTransport(undefined, () => ({ ok: true }))
    assert.deepEqual(await transport.readJson(requestBody(Buffer.from('{"message":"hello"}'))), { message: 'hello' })
    await assert.rejects(
      transport.readJson(requestBody(Buffer.alloc(65_537, 32))),
      /request too large/,
    )
  })

  it('refuses unsafe JSON before writing a response', () => {
    const transport = new WebUiHttpTransport(undefined, () => ({ ok: true }))
    const captured = capturedResponse()
    assert.throws(
      () => transport.sendJson(captured.response, 200, { type: 'reasoning', text: 'hidden' }),
      /refusing to emit/,
    )
    assert.equal(captured.status(), undefined)
    assert.deepEqual(captured.ends, [])
  })

  it('deduplicates SSE projections and removes closed clients', () => {
    let revision = 1
    const transport = new WebUiHttpTransport(undefined, () => ({ revision }))
    const req = new EventEmitter() as IncomingMessage
    const captured = capturedResponse()
    transport.openEvents(req, captured.response)
    assert.equal(captured.status(), 200)
    assert.equal(captured.writes.length, 1)
    assert.match(captured.writes[0] ?? '', /"revision":1/)

    transport.broadcast()
    assert.equal(captured.writes.length, 1)
    revision = 2
    transport.broadcast()
    assert.equal(captured.writes.length, 2)
    assert.match(captured.writes[1] ?? '', /"revision":2/)

    req.emit('close')
    revision = 3
    transport.broadcast()
    assert.equal(captured.writes.length, 2)
  })

  it('refuses static resource traversal and reports a missing asset root', () => {
    const transport = new WebUiHttpTransport('/definitely/missing/tars-ng-assets', () => ({ ok: true }))
    const traversal = capturedResponse()
    transport.serveAsset('/../../private.txt', traversal.response, false)
    assert.equal(traversal.status(), 403)

    const missing = capturedResponse()
    transport.serveAsset('/missing.js', missing.response, false)
    assert.equal(missing.status(), 404)
    assert.equal(missing.ends[0], 'Web UI assets are not installed')
  })
})
