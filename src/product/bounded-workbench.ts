import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FsEditOutcome, type FsEditRequest, type FsPathInfo, type FsTarget, type FsVersion, type FsWriteIntent, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ConfinedRootError, resolveConfined } from '../domain/files/confined-root.js'
import { inspectSandboxRoot } from '../domain/files/sandbox-root.js'

/**
 * DSH's local filesystem is deliberately provider-neutral and does not confine reads.
 * This product adapter makes the existing Files root the single authority for both
 * reads and mutations. Relative paths never inherit the session cwd.
 */
export class BoundedWorkspaceFileSystem extends SandboxedFileSystem {
  constructor(ctx: Context, readonly workspaceRoot: string) {
    super(ctx, { cwd: workspaceRoot, diffBasisMaxBytes: 10 * 1024 * 1024 })
  }

  override async resolve(filePath: string, opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<FsTarget> {
    try {
      const absolute = filePath === '.' ? this.workspaceRoot : resolveConfined(this.workspaceRoot, filePath)
      const target = await super.resolve(absolute, { signal: opts.signal })
      return { ...target, displayPath: filePath === '.' ? '.' : filePath.replaceAll('\\', '/') }
    } catch (error) {
      if (!(error instanceof ConfinedRootError)) throw error
      throw new FsError(error.message, 'FS_SANDBOX_DENIED', { cause: error })
    }
  }

  override async lstat(filePath: string, _opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(filePath, { signal })
    return super.lstat(this.processPath(target), undefined, signal)
  }

  override writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(target, content, expected, signal, this.productPolicy(sandboxPolicy))
  }

  override editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(target, edit, expected, signal, this.productPolicy(sandboxPolicy))
  }

  private productPolicy(policy: SandboxExecutionPolicy | undefined): SandboxExecutionPolicy | undefined {
    return policy === undefined ? undefined : { ...policy, workspaceRoot: this.workspaceRoot }
  }
}

/** Mount the first bounded-workbench slice only when the operator configured Files. */
export async function mountBoundedWorkbench(ctx: Context, configuredRoot = process.env.DSH_ASSISTANT_SANDBOX_ROOT): Promise<boolean> {
  const inspected = inspectSandboxRoot(configuredRoot)
  if (!inspected.configured || !inspected.ok) return false
  const workspaceRoot = inspected.root

  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot })
  await ctx.plugin(class BoundedWorkspaceFileSystemPlugin extends BoundedWorkspaceFileSystem {
    constructor(scope: Context) {
      super(scope, workspaceRoot)
    }
  })
  await ctx.plugin(FsObservationPolicy)
  await ctx.plugin(ToolFs, {
    readLimit: 500,
    readMaxLineLength: 2_000,
    readMaxBytes: 64 * 1024,
    readStreamMinSize: 256 * 1024,
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolFsSearch, {
    sampleOverCapGlobResults: true,
    globMaxResults: 100,
    grepMaxMatches: 250,
    grepMaxLineBytes: 2_000,
    rawOutputMaxBytes: 4 * 1024 * 1024,
    timeoutMs: 15_000,
    graceMs: 1_000,
    stderrMaxBytes: 32 * 1024,
  })
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'glob' && exec.name !== 'grep') return next()
    if (exec.agent?.session.header.cwd !== workspaceRoot) {
      return { kind: 'deny', reason: 'search requires a session bound to the configured Files workspace; start a new session' }
    }
    const requestedPath = (exec.arguments as Record<string, unknown> | undefined)?.path
    if (requestedPath !== undefined) {
      if (typeof requestedPath !== 'string') return { kind: 'deny', reason: 'search path must be a confined relative path' }
      try {
        if (requestedPath !== '.') resolveConfined(workspaceRoot, requestedPath)
      } catch {
        return { kind: 'deny', reason: 'search path must stay inside the configured Files workspace' }
      }
    }
    return next()
  }))
  return true
}

export function boundedWorkspaceRoot(ctx: Context): string | undefined {
  const fs = ctx.get('fs')
  return fs instanceof BoundedWorkspaceFileSystem ? fs.workspaceRoot : undefined
}
