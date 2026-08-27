import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSafePayload,
  createUiSessionToken,
  sessionCookieHeader,
  sessionMatches,
} from './web-ui-protocol.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_REQUEST_BYTES = 65_536

export function defaultWebAssetRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web')
}

export class WebUiHttpTransport {
  private readonly assetRoot: string
  private readonly sessionToken = createUiSessionToken()
  private readonly clients = new Set<ServerResponse>()
  private lastPayload = ''

  constructor(
    assetRoot: string | undefined,
    private readonly project: () => unknown,
  ) {
    this.assetRoot = path.resolve(assetRoot ?? defaultWebAssetRoot())
  }

  mutationTrusted(method: string | undefined, cookie: string | undefined): boolean {
    return !MUTATING.has(method ?? 'GET') || sessionMatches(cookie, this.sessionToken)
  }

  async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) throw new Error('request too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }

  sendJson(res: ServerResponse, status: number, body: unknown, setSession = false): void {
    const payload = assertSafePayload(JSON.stringify(body))
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    }
    if (setSession) headers['set-cookie'] = sessionCookieHeader(this.sessionToken)
    res.writeHead(status, headers)
    res.end(payload)
  }

  openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    this.clients.add(res)
    const payload = this.safeProjection()
    this.lastPayload = payload
    res.write(`event: view\ndata: ${payload}\n\n`)
    req.on('close', () => {
      this.clients.delete(res)
    })
  }

  broadcast(): void {
    let payload: string
    try {
      payload = this.safeProjection()
    } catch {
      return
    }
    if (payload === this.lastPayload) return
    this.lastPayload = payload
    for (const client of this.clients) client.write(`event: view\ndata: ${payload}\n\n`)
  }

  serveAsset(reqPath: string, res: ServerResponse, setSession: boolean): void {
    const relative = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '')
    const target = path.resolve(this.assetRoot, relative)
    if (!target.startsWith(`${this.assetRoot}${path.sep}`) && target !== this.assetRoot) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      if (reqPath === '/' || !path.extname(reqPath)) {
        const index = path.join(this.assetRoot, 'index.html')
        if (existsSync(index)) {
          res.writeHead(200, {
            'content-type': MIME['.html'],
            ...(setSession ? { 'set-cookie': sessionCookieHeader(this.sessionToken) } : {}),
          })
          createReadStream(index).pipe(res)
          return
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Web UI assets are not installed')
      return
    }
    const mime = MIME[path.extname(target)] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-store',
      ...(setSession && target.endsWith(`${path.sep}index.html`)
        ? { 'set-cookie': sessionCookieHeader(this.sessionToken) }
        : {}),
    })
    createReadStream(target).pipe(res)
  }

  close(): void {
    for (const client of this.clients) client.end()
    this.clients.clear()
  }

  private safeProjection(): string {
    return assertSafePayload(JSON.stringify(this.project()))
  }
}
