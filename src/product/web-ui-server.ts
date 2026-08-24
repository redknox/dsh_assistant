import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ActivationDeniedError, UninstallDeniedError } from '../domain/governance/errors.js'
import { SimulatedCrashError } from '../domain/governance/service.js'
import type { RecoveryRoot } from '../domain/governance/root.js'
import { boundActivationDiagnostics } from '../domain/workspace/failure.js'
import { AssistantControlSurface } from '../ui/controller.js'
import type { ActivationCard, ApprovalCard, MissionControlView, UserPluginView } from '../domain/workspace/types.js'
import { PRODUCT_UI_SESSION_ID } from './constants.js'
import {
  assertSafePayload,
  createUiSessionToken,
  DESTRUCTIVE_RECOVERY_ACTIONS,
  originAllowed,
  resolveWebUiListen,
  sessionCookieHeader,
  sessionMatches,
  SUPPORTED_RECOVERY_ACTIONS,
  type WebUiListenOptions,
} from './web-ui-protocol.js'

export interface WebUiServerOptions extends WebUiListenOptions {
  readonly surface: AssistantControlSurface
  readonly recoveryRoot: RecoveryRoot
  readonly diagnostics?: unknown
  readonly assetRoot?: string
}

export interface WebUiServer {
  readonly url: string
  readonly host: string
  readonly port: number
  notify(): void
  close(): Promise<void>
}

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

export function defaultWebAssetRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web')
}

export function startWebUiServer(options: WebUiServerOptions): Promise<WebUiServer> {
  const listen = resolveWebUiListen(process.env, options)
  const assetRoot = path.resolve(options.assetRoot ?? defaultWebAssetRoot())
  const sessionToken = createUiSessionToken()
  const clients = new Set<ServerResponse>()
  let url = ''
  let lastPayload = ''
  let poll: ReturnType<typeof setInterval> | undefined

  const snapshot = (): MissionControlView => options.surface.workspace()

  const envelope = () => ({ view: snapshot(), webUi: url })

  const sendJson = (res: ServerResponse, status: number, body: unknown, setSession = false) => {
    const payload = assertSafePayload(JSON.stringify(body))
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    }
    if (setSession) headers['set-cookie'] = sessionCookieHeader(sessionToken)
    res.writeHead(status, headers)
    res.end(payload)
  }

  const rejectOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin
    if (originAllowed(typeof origin === 'string' ? origin : undefined, listen.host, boundPort())) return false
    sendJson(res, 403, { error: 'unsupported origin' })
    return true
  }

  const rejectUntrustedMutation = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!MUTATING.has(req.method ?? 'GET')) return false
    if (sessionMatches(req.headers.cookie, sessionToken)) return false
    sendJson(res, 403, { error: 'untrusted session' })
    return true
  }

  const boundPort = (): number => {
    const address = server.address()
    return typeof address === 'object' && address ? address.port : listen.port
  }

  const broadcast = () => {
    let payload: string
    try {
      payload = assertSafePayload(JSON.stringify(envelope()))
    } catch {
      return
    }
    if (payload === lastPayload) return
    lastPayload = payload
    for (const client of clients) {
      client.write(`event: view\ndata: ${payload}\n\n`)
    }
  }

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 65_536) throw new Error('request too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  const handleRecovery = async (action: string, confirm: boolean) => {
    if (!(SUPPORTED_RECOVERY_ACTIONS as readonly string[]).includes(action)) {
      return { status: 409 as const, body: { error: 'unsupported', action } }
    }
    if ((DESTRUCTIVE_RECOVERY_ACTIONS as readonly string[]).includes(action) && confirm !== true) {
      return { status: 409 as const, body: { error: 'confirmation-required', action } }
    }
    if (action === 'diagnostics') {
      return {
        status: 200 as const,
        body: { action, diagnostics: options.diagnostics ?? { activation: options.recoveryRoot.inspect() } },
      }
    }
    const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
    if (action === 'rollback') {
      return { status: 200 as const, body: { action, result: await options.recoveryRoot.rollback(human) } }
    }
    const status = options.recoveryRoot.inspect()
    if (status.recoveryRequired) {
      return { status: 409 as const, body: { error: 'integrity-failure', action: 'exit-safe-mode' } }
    }
    return { status: 200 as const, body: { action, result: options.recoveryRoot.exitSafeMode(human) } }
  }

  const bindCard = (body: { id?: unknown; candidateId?: unknown; fingerprint?: unknown }, cards: readonly ApprovalCard[]) => {
    if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' as const }
    if (typeof body.fingerprint !== 'string' || body.fingerprint === '') return { error: 'malformed' as const }
    const card = cards.find((item) => item.id === body.id)
    if (!card) return { error: 'unknown-approval' as const }
    if (card.fingerprint !== body.fingerprint) return { error: 'stale-fingerprint' as const }
    if (card.kind === 'self-extension') {
      if (typeof body.candidateId !== 'string' || body.candidateId === '' || body.candidateId !== card.candidateId) {
        return { error: 'stale-candidate' as const }
      }
    }
    return { card }
  }

  let activationBusy = false
  let uninstallBusy = false

  const activationInFlight = () => {
    if (activationBusy) return true
    const state = options.recoveryRoot.inspect().state
    return state === 'activating' || state === 'activation-pending'
  }

  const bindActivation = (body: {
    id?: unknown
    candidateId?: unknown
    digest?: unknown
    fingerprint?: unknown
  }, cards: readonly ActivationCard[]) => {
    if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' as const }
    if (typeof body.candidateId !== 'string' || body.candidateId === '') return { error: 'malformed' as const }
    if (typeof body.digest !== 'string' || body.digest === '') return { error: 'malformed' as const }
    if (typeof body.fingerprint !== 'string' || body.fingerprint === '') return { error: 'malformed' as const }
    const card = cards.find((item) => item.id === body.id)
    if (!card) return { error: 'unknown-activation' as const }
    if (card.candidateId !== body.candidateId) return { error: 'stale-candidate' as const }
    if (card.digest !== body.digest) return { error: 'stale-digest' as const }
    if (card.fingerprint !== body.fingerprint) return { error: 'stale-fingerprint' as const }
    if (card.status !== 'APPROVED_NOT_ACTIVE') return { error: 'stale-activation' as const }
    return { card }
  }

  const bindUninstall = (body: {
    id?: unknown
    owner?: unknown
    version?: unknown
    candidateId?: unknown
    digest?: unknown
    registryGeneration?: unknown
  }, cards: readonly UserPluginView[]) => {
    if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' as const }
    if (typeof body.owner !== 'string' || body.owner === '') return { error: 'malformed' as const }
    if (typeof body.version !== 'string' || body.version === '') return { error: 'malformed' as const }
    if (typeof body.registryGeneration !== 'number' || !Number.isInteger(body.registryGeneration)) {
      return { error: 'malformed' as const }
    }
    const card = cards.find((item) => item.id === body.id)
    if (!card) return { error: 'unknown-plugin' as const }
    if (card.owner !== body.owner || card.version !== body.version) return { error: 'stale-plugin' as const }
    if (card.registryGeneration !== body.registryGeneration) return { error: 'stale-registry' as const }
    if (card.candidateId !== undefined) {
      if (typeof body.candidateId !== 'string' || body.candidateId !== card.candidateId) {
        return { error: 'stale-candidate' as const }
      }
    }
    if (card.digest !== undefined) {
      if (typeof body.digest !== 'string' || body.digest !== card.digest) {
        return { error: 'stale-digest' as const }
      }
    }
    return { card }
  }

  const serveAsset = (reqPath: string, res: ServerResponse, setSession: boolean) => {
    const relative = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '')
    const target = path.resolve(assetRoot, relative)
    if (!target.startsWith(`${assetRoot}${path.sep}`) && target !== assetRoot) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      if (reqPath === '/' || !path.extname(reqPath)) {
        const index = path.join(assetRoot, 'index.html')
        if (existsSync(index)) {
          res.writeHead(200, {
            'content-type': MIME['.html'],
            ...(setSession ? { 'set-cookie': sessionCookieHeader(sessionToken) } : {}),
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
      ...(setSession && target.endsWith(`${path.sep}index.html`) ? { 'set-cookie': sessionCookieHeader(sessionToken) } : {}),
    })
    createReadStream(target).pipe(res)
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (rejectOrigin(req, res)) return
      if (rejectUntrustedMutation(req, res)) return
      const hostHeader = req.headers.host ?? `${listen.host}:${boundPort()}`
      const requestUrl = new URL(req.url ?? '/', `http://${hostHeader}`)
      if (req.method === 'GET' && requestUrl.pathname === '/api/session') {
        sendJson(res, 200, { ok: true, webUi: url }, true)
        return
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/view') {
        sendJson(res, 200, envelope())
        return
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        clients.add(res)
        const payload = assertSafePayload(JSON.stringify(envelope()))
        lastPayload = payload
        res.write(`event: view\ndata: ${payload}\n\n`)
        req.on('close', () => {
          clients.delete(res)
        })
        return
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/message') {
        const body = JSON.parse(await readBody(req)) as { text?: unknown }
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          sendJson(res, 400, { error: 'malformed' })
          return
        }
        options.surface.sendMessage(body.text.trim())
        sendJson(res, 202, envelope())
        broadcast()
        return
      }
      if (req.method === 'POST' && (requestUrl.pathname === '/api/approve' || requestUrl.pathname === '/api/deny' || requestUrl.pathname === '/api/cancel')) {
        const body = JSON.parse(await readBody(req)) as { id?: unknown; candidateId?: unknown; fingerprint?: unknown }
        const bound = bindCard(body, snapshot().approvals)
        if ('error' in bound) {
          sendJson(res, bound.error === 'malformed' ? 400 : 409, { error: bound.error })
          return
        }
        const decision = requestUrl.pathname === '/api/approve' ? 'approve' : requestUrl.pathname === '/api/deny' ? 'deny' : 'cancel'
        const { card } = bound
        if (card.kind === 'self-extension') {
          if (decision === 'cancel') {
            sendJson(res, 409, { error: 'unsupported', action: 'cancel-self-extension' })
            return
          }
          const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
          options.recoveryRoot.recordApproval(human, {
            candidateId: card.candidateId ?? '',
            fingerprint: card.fingerprint,
            decision: decision === 'approve' ? 'approved-for-exact-diff' : 'rejected',
          })
        } else if (decision === 'approve') {
          await options.surface.approve(card.id)
        } else if (decision === 'deny') {
          await options.surface.deny(card.id)
        } else {
          await options.surface.cancelConfirmation(card.id)
        }
        sendJson(res, 200, envelope())
        broadcast()
        return
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/activate') {
        const body = JSON.parse(await readBody(req)) as {
          id?: unknown
          candidateId?: unknown
          digest?: unknown
          fingerprint?: unknown
          confirm?: unknown
        }
        if (body.confirm !== true) {
          sendJson(res, 409, { error: 'confirmation-required' })
          return
        }
        if (activationInFlight()) {
          sendJson(res, 409, { error: 'activation-in-flight', view: snapshot(), webUi: url })
          return
        }
        const bound = bindActivation(body, snapshot().activations)
        if ('error' in bound) {
          sendJson(res, bound.error === 'malformed' ? 400 : 409, { error: bound.error })
          return
        }
        const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
        activationBusy = true
        try {
          const status = await options.recoveryRoot.activate(bound.card.candidateId, human)
          if (status.state === 'activation-failed' || status.state === 'safe-mode') {
            const failure = status.lastFailure
            sendJson(res, 409, {
              error: 'activation-failed',
              phase: failure?.phase,
              diagnostics: failure?.diagnostics ? boundActivationDiagnostics(failure.diagnostics) : 'activation failed',
              rollbackSucceeded: failure?.rollbackSucceeded === true,
              recoveryRequired: status.recoveryRequired,
              safeMode: status.safeMode,
              active: false,
              view: snapshot(),
              webUi: url,
            })
            broadcast()
            return
          }
          sendJson(res, 200, envelope())
          broadcast()
        } catch (error) {
          if (error instanceof ActivationDeniedError) {
            sendJson(res, 409, { error: 'activation-denied', denials: error.denials, view: snapshot(), webUi: url })
            broadcast()
            return
          }
          if (error instanceof SimulatedCrashError) {
            sendJson(res, 409, {
              error: 'activation-interrupted',
              phase: error.message.replace('simulated crash after ', ''),
              diagnostics: boundActivationDiagnostics(error.message),
              view: snapshot(),
              webUi: url,
            })
            broadcast()
            return
          }
          const message = error instanceof Error ? error.message : 'activation failed'
          sendJson(res, 409, {
            error: 'activation-error',
            diagnostics: boundActivationDiagnostics(message),
            view: snapshot(),
            webUi: url,
          })
          broadcast()
        } finally {
          activationBusy = false
        }
        return
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/uninstall') {
        const body = JSON.parse(await readBody(req)) as {
          id?: unknown
          owner?: unknown
          version?: unknown
          candidateId?: unknown
          digest?: unknown
          registryGeneration?: unknown
          confirm?: unknown
        }
        if (body.confirm !== true) {
          sendJson(res, 409, { error: 'confirmation-required' })
          return
        }
        if (uninstallBusy || activationInFlight()) {
          sendJson(res, 409, { error: 'uninstall-in-flight', view: snapshot(), webUi: url })
          return
        }
        const bound = bindUninstall(body, snapshot().plugins)
        if ('error' in bound) {
          sendJson(res, bound.error === 'malformed' ? 400 : 409, { error: bound.error })
          return
        }
        const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
        uninstallBusy = true
        try {
          await options.recoveryRoot.uninstall(human, bound.card.owner, bound.card.version)
          sendJson(res, 200, envelope())
          broadcast()
        } catch (error) {
          if (error instanceof UninstallDeniedError) {
            sendJson(res, 409, { error: 'uninstall-denied', denials: error.denials, view: snapshot(), webUi: url })
            broadcast()
            return
          }
          const message = error instanceof Error ? error.message : 'uninstall failed'
          sendJson(res, 409, {
            error: 'uninstall-failed',
            diagnostics: boundActivationDiagnostics(message),
            view: snapshot(),
            webUi: url,
          })
          broadcast()
        } finally {
          uninstallBusy = false
        }
        return
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/recovery') {
        const body = JSON.parse(await readBody(req)) as { action?: unknown; confirm?: unknown }
        if (typeof body.action !== 'string') {
          sendJson(res, 400, { error: 'malformed' })
          return
        }
        const result = await handleRecovery(body.action, body.confirm === true)
        sendJson(res, result.status, { ...result.body, view: snapshot(), webUi: url })
        broadcast()
        return
      }
      if (req.method === 'GET' && !requestUrl.pathname.startsWith('/api/')) {
        serveAsset(requestUrl.pathname, res, requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed'
      if (message.includes('fingerprint')) {
        sendJson(res, 409, { error: 'stale-fingerprint' })
        return
      }
      if (message.includes('unknown') || message.includes('not found')) {
        sendJson(res, 409, { error: 'unknown-candidate' })
        return
      }
      sendJson(res, 400, { error: message.startsWith('refusing') ? 'unsafe payload' : 'malformed' })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listen.port, listen.host, () => {
      const port = boundPort()
      const host = listen.host === '::1' ? '[::1]' : listen.host
      url = `http://${host}:${port}`
      poll = setInterval(() => broadcast(), 750)
      resolve({
        url,
        host: listen.host,
        port,
        notify: broadcast,
        close: () => new Promise((done, fail) => {
          if (poll) clearInterval(poll)
          for (const client of clients) client.end()
          clients.clear()
          server.close((error) => error ? fail(error) : done())
        }),
      })
    })
  })
}

export function attachWebUiBroadcast(ctx: { on(event: string, listener: (...args: never[]) => void): unknown }, push: () => void): () => void {
  // Observe-only. tools/pre-execute is a waterfall gate; a void listener returns
  // undefined and every tool then fails with "Cannot read properties of undefined (reading 'kind')".
  const names = ['agent/status', 'session/event', 'session/flush', 'tools/result']
  const offs = names.map((name) => ctx.on(name, push))
  return () => {
    for (const off of offs) {
      if (typeof off === 'function') off()
    }
  }
}

export { PRODUCT_UI_SESSION_ID }
