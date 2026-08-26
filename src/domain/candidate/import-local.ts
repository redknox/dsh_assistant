import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { GENERATED_EXTENSION_API_V1 } from '../workbench/authoring-contract.js'
import { normalizeManifest } from './manifest.js'
import {
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_LIST_DEPTH,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WORKBENCH_MAX_WORKSPACE_BYTES,
  type CandidateWorkbench,
} from '../workbench/types.js'
import { contractDigestExtras, digestFiles } from './digest.js'
import { ImportLocalError } from './errors.js'
import { listSourceFiles } from './files.js'
import type { RegistryReadModel, ResolutionReview } from '../resolution/types.js'
import type { CandidateRecord, CandidateWorkspace } from './types.js'

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const OWNER_SLUG = /^[a-z][a-z0-9-]*$/
const SECRET_KEY = /(secret|password|passwd|api[_-]?key|token|credential|private[_-]?key|authorization)/i
const FORBIDDEN_BASENAMES = new Set([
  'node_modules',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'candidate.manifest.json',
])
const FORBIDDEN_EXTENSIONS = new Set(['.node', '.wasm', '.so', '.dylib', '.dll', '.exe'])
const ALLOWED_RELATIVE = /^(package\.json|generated-extension-api\.json|tars-ng\.import\.json|src\/[A-Za-z0-9._-]+\.js)$/

export interface ImportLocalResult {
  readonly status: 'imported' | 'duplicate'
  readonly candidateId: string
  readonly owner: string
  readonly version: string
  readonly provenance: { readonly kind: 'third-party'; readonly origin: 'import' }
  readonly lifecycle: string
  readonly sealed: boolean
  readonly digest?: string
  readonly nextAction: 'validate'
}

export function importLocalExtension(input: {
  readonly sourceDir: string
  readonly workspace: CandidateWorkspace
  readonly workbench: Pick<CandidateWorkbench, 'adoptImported'>
  readonly registry: Pick<RegistryReadModel, 'list'>
  readonly inject?: { readonly failAfterWriting: string }
}): ImportLocalResult {
  const preview = inspectLocalBundle(input.sourceDir)
  const active = input.registry.list({ owner: preview.owner, status: 'active' })[0]
  const baseVersion = active !== undefined && active.version !== preview.version ? active.version : undefined
  const inspected = inspectLocalBundle(input.sourceDir, baseVersion)
  const existing = input.workspace.list().find((item) => (
    item.owner === inspected.owner && item.version === inspected.version
  ))
  if (existing) {
    const existingDigest = digestFiles(
      existing.workspaceRoot,
      listSourceFiles(existing.workspaceRoot),
      contractDigestExtras(existing.manifest.runtimeContractVersion),
    )
    if (existingDigest === inspected.plannedDigest) {
      input.workbench.adoptImported(existing.id)
      return resultOf(existing, 'duplicate')
    }
    throw new ImportLocalError(
      'import-duplicate-conflict',
      `same owner/version already imported with different bytes: ${inspected.owner}@${inspected.version}`,
    )
  }

  let created: CandidateRecord | undefined
  try {
    created = input.workspace.create({
      review: inspected.review,
      owner: inspected.owner,
      version: inspected.version,
      baseVersion,
      provenance: { kind: 'third-party', origin: 'import' },
      manifest: {
        capabilities: [inspected.capability],
        tools: inspected.tools,
        entryPoints: ['src/plugin.js'],
        runtimeContractVersion: GENERATED_EXTENSION_API_V1,
        effects: { remoteSideEffect: 'none' },
      },
      files: inspected.files,
      onAfterWriteFile: input.inject === undefined
        ? undefined
        : (relativePath) => {
          if (relativePath === input.inject?.failAfterWriting) {
            throw new ImportLocalError('import-interrupted', `injected failure after writing ${relativePath}`)
          }
        },
    })
    input.workbench.adoptImported(created.id)
    return resultOf(input.workspace.get(created.id), 'imported')
  } catch (error) {
    if (created !== undefined) {
      try {
        input.workspace.discard(created.id)
      } catch {
        // fail closed: publication did not complete
      }
    }
    if (error instanceof ImportLocalError) throw error
    throw new ImportLocalError(
      'import-interrupted',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function resultOf(record: CandidateRecord, status: ImportLocalResult['status']): ImportLocalResult {
  return {
    status,
    candidateId: record.id,
    owner: record.owner,
    version: record.version,
    provenance: { kind: 'third-party', origin: 'import' },
    lifecycle: record.lifecycle,
    sealed: record.sealed,
    digest: record.digest,
    nextAction: 'validate',
  }
}

interface InspectedBundle {
  readonly owner: string
  readonly version: string
  readonly capability: string
  readonly tools: readonly string[]
  readonly files: Record<string, string>
  readonly plannedDigest: string
  readonly review: ResolutionReview
}

function inspectLocalBundle(sourceDir: string, baseVersion?: string): InspectedBundle {
  if (typeof sourceDir !== 'string' || sourceDir.trim() === '') {
    throw new ImportLocalError('import-boundary', 'import-local requires one source directory')
  }
  const resolved = path.resolve(sourceDir)
  if (!existsSync(resolved)) {
    throw new ImportLocalError('import-boundary', `import source does not exist: ${sourceDir}`)
  }
  const rootStat = lstatSync(resolved)
  if (rootStat.isSymbolicLink()) {
    throw new ImportLocalError('import-boundary', 'import source must not be a symlink')
  }
  if (!rootStat.isDirectory()) {
    throw new ImportLocalError('import-boundary', 'import source must be a directory')
  }

  const collected = collectAllowedFiles(resolved)
  const pkgRaw = collected.get('package.json')
  if (pkgRaw === undefined) {
    throw new ImportLocalError('import-boundary', 'import source is missing package.json')
  }
  const pkg = parseJsonObject(pkgRaw, 'package.json')
  rejectSecrets(pkg, 'package.json')
  rejectPackageInstallSurface(pkg)
  if (collected.has('generated-extension-api.json')) {
    const stamp = parseJsonObject(collected.get('generated-extension-api.json')!, 'generated-extension-api.json')
    if (stamp.version !== GENERATED_EXTENSION_API_V1) {
      throw new ImportLocalError('import-boundary', 'unsupported authoring contract in source stamp')
    }
  }
  const descriptor = collected.has('tars-ng.import.json')
    ? parseImportDescriptor(collected.get('tars-ng.import.json')!)
    : {}
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  if (!STRICT_SEMVER.test(version)) {
    throw new ImportLocalError('import-boundary', `third-party version must be strict semver: ${JSON.stringify(pkg.version)}`)
  }
  const slug = ownerSlugOf(typeof pkg.name === 'string' ? pkg.name : '')
  const owner = `third-party/${slug}`
  const capability = capabilityOf(descriptor, pkg, slug)
  const tools = toolsOf(descriptor, pkg, slug)
  const entry = typeof pkg.main === 'string' ? pkg.main.replaceAll('\\', '/') : 'src/plugin.js'
  if (entry !== 'src/plugin.js') {
    throw new ImportLocalError('import-boundary', `unsupported entry point: ${entry}`)
  }
  if (!collected.has('src/plugin.js')) {
    throw new ImportLocalError('import-boundary', 'import source is missing src/plugin.js')
  }
  if (pkg.type !== undefined && pkg.type !== 'module') {
    throw new ImportLocalError('import-boundary', 'generated-extension-api/v1 requires package.json type module')
  }

  const files: Record<string, string> = {}
  for (const [relative, content] of collected) {
    if (relative === 'tars-ng.import.json') continue
    files[relative] = content
  }
  files['generated-extension-api.json'] = `${JSON.stringify({ version: GENERATED_EXTENSION_API_V1 }, null, 2)}\n`

  const review = {
    kind: 'adopt-existing' as const,
    capability,
    need: 'import a local third-party extension bundle',
    recommendation: 'Import the operator-supplied local bundle as an inactive third-party candidate.',
    rationale: 'Host-stamped third-party import. Bundle claims cannot elevate provenance.',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: {
      exact: { kind: 'unknown' as const, capability },
      domainOwners: [],
      conflicts: [],
    },
    target: { owner, ...(baseVersion === undefined ? {} : { version: baseVersion }) },
  }
  const plannedManifest = normalizeManifest(
    review,
    owner,
    version,
    baseVersion,
    { kind: 'third-party', origin: 'import' },
    {
      capabilities: [capability],
      tools,
      entryPoints: ['src/plugin.js'],
      runtimeContractVersion: GENERATED_EXTENSION_API_V1,
      effects: { remoteSideEffect: 'none' },
    },
  )
  const plannedFiles = {
    ...files,
    'candidate.manifest.json': `${JSON.stringify(plannedManifest, null, 2)}\n`,
  }
  return {
    owner,
    version,
    capability,
    tools,
    files,
    plannedDigest: digestMap(plannedFiles, contractDigestExtras(GENERATED_EXTENSION_API_V1)),
    review,
  }
}

function collectAllowedFiles(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const seenLower = new Map<string, string>()
  let visited = 0
  let total = 0
  const walk = (dirPath: string, rel: string, depth: number) => {
    if (depth > WORKBENCH_MAX_LIST_DEPTH) {
      throw new ImportLocalError('import-boundary', `import listing exceeded the depth bound of ${WORKBENCH_MAX_LIST_DEPTH}`)
    }
    const names = readdirSync(dirPath)
    for (const name of names) {
      visited += 1
      if (visited > WORKBENCH_MAX_TRAVERSAL_ENTRIES) {
        throw new ImportLocalError('import-boundary', `import listing exceeded the traversal bound of ${WORKBENCH_MAX_TRAVERSAL_ENTRIES}`)
      }
      const relative = rel === '' ? name : `${rel}/${name}`
      const full = path.join(dirPath, name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        throw new ImportLocalError('import-boundary', `symlink is not allowed: ${relative}`)
      }
      const lower = relative.toLowerCase()
      const prior = seenLower.get(lower)
      if (prior !== undefined && prior !== relative) {
        throw new ImportLocalError('import-boundary', `case-collision ambiguity: ${prior} vs ${relative}`)
      }
      seenLower.set(lower, relative)
      if (FORBIDDEN_BASENAMES.has(name) || name === 'node_modules') {
        throw new ImportLocalError('import-boundary', `unexpected import path: ${relative}`)
      }
      if (stat.isDirectory()) {
        if (name === 'node_modules' || name === '.git') {
          throw new ImportLocalError('import-boundary', `unexpected import path: ${relative}`)
        }
        walk(full, relative, depth + 1)
        continue
      }
      if (!stat.isFile()) {
        throw new ImportLocalError('import-boundary', `non-regular file is not allowed: ${relative}`)
      }
      if (path.isAbsolute(relative) || relative.includes('..') || relative.includes('\\')) {
        throw new ImportLocalError('import-boundary', `path traversal is not allowed: ${relative}`)
      }
      if (!ALLOWED_RELATIVE.test(relative)) {
        throw new ImportLocalError('import-boundary', `file outside the bounded extension allowlist: ${relative}`)
      }
      const ext = path.extname(name).toLowerCase()
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        throw new ImportLocalError('import-boundary', `native or binary artifact is not allowed: ${relative}`)
      }
      if (stat.size > WORKBENCH_MAX_FILE_BYTES) {
        throw new ImportLocalError('import-boundary', `import file exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
      }
      total += stat.size
      if (total > WORKBENCH_MAX_WORKSPACE_BYTES) {
        throw new ImportLocalError('import-boundary', `import workspace exceeds the ${WORKBENCH_MAX_WORKSPACE_BYTES} byte bound`)
      }
      if (files.size >= WORKBENCH_MAX_FILE_COUNT) {
        throw new ImportLocalError('import-boundary', `import exceeds the ${WORKBENCH_MAX_FILE_COUNT} file bound`)
      }
      files.set(relative, readFileSync(full, 'utf8'))
    }
  }
  walk(root, '', 0)
  return files
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ImportLocalError('import-boundary', `${label} is not valid JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ImportLocalError('import-boundary', `${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function parseImportDescriptor(raw: string): Record<string, unknown> {
  const parsed = parseJsonObject(raw, 'tars-ng.import.json')
  const allowed = new Set(['capability', 'tools', 'package', 'integrity'])
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      throw new ImportLocalError('import-boundary', `malformed or future import descriptor field: ${key}`)
    }
  }
  rejectSecrets(parsed, 'tars-ng.import.json')
  return parsed
}

function rejectPackageInstallSurface(pkg: Record<string, unknown>): void {
  const scripts = pkg.scripts
  if (scripts !== undefined && (typeof scripts !== 'object' || scripts === null || Object.keys(scripts as object).length > 0)) {
    throw new ImportLocalError('import-boundary', 'package scripts are not allowed')
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const value = pkg[field]
    if (value !== undefined && (typeof value !== 'object' || value === null || Object.keys(value as object).length > 0)) {
      throw new ImportLocalError('import-boundary', `${field} are not allowed`)
    }
  }
  for (const field of ['install', 'gypfile', 'binary', 'os', 'cpu', 'libc']) {
    if (pkg[field] !== undefined) {
      throw new ImportLocalError('import-boundary', `unexpected install field: ${field}`)
    }
  }
}

function rejectSecrets(value: unknown, label: string): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) rejectSecrets(item, label)
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      throw new ImportLocalError('import-boundary', `secret-bearing metadata is not allowed in ${label}`)
    }
    if (typeof nested === 'string' && SECRET_KEY.test(nested) && nested.length < 80) {
      throw new ImportLocalError('import-boundary', `secret-bearing metadata is not allowed in ${label}`)
    }
    rejectSecrets(nested, label)
  }
}

function ownerSlugOf(name: string): string {
  const leaf = name.trim().split('/').at(-1) ?? ''
  const slug = leaf.toLowerCase().replace(/^@/, '').replaceAll('_', '-').replace(/[^a-z0-9-]/g, '')
  if (!OWNER_SLUG.test(slug)) {
    throw new ImportLocalError('import-boundary', `cannot derive a third-party owner from package name: ${JSON.stringify(name)}`)
  }
  return slug
}

function capabilityOf(descriptor: Record<string, unknown>, pkg: Record<string, unknown>, slug: string): string {
  const tars = pkg.tarsNg !== null && typeof pkg.tarsNg === 'object' && !Array.isArray(pkg.tarsNg)
    ? pkg.tarsNg as Record<string, unknown>
    : {}
  const raw = typeof descriptor.capability === 'string'
    ? descriptor.capability
    : typeof tars.capability === 'string'
      ? tars.capability
      : slug.includes('-')
        ? slug.split('-').slice(0, 2).join('.')
        : `plugin.${slug}`
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(raw)) {
    throw new ImportLocalError('import-boundary', `malformed capability identity: ${JSON.stringify(raw)}`)
  }
  return raw
}

function toolsOf(descriptor: Record<string, unknown>, pkg: Record<string, unknown>, slug: string): readonly string[] {
  const tars = pkg.tarsNg !== null && typeof pkg.tarsNg === 'object' && !Array.isArray(pkg.tarsNg)
    ? pkg.tarsNg as Record<string, unknown>
    : {}
  const raw = descriptor.tools ?? tars.tools
  if (Array.isArray(raw)) {
    const tools = raw.map((item) => {
      if (typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(item)) {
        throw new ImportLocalError('import-boundary', `malformed tool name: ${JSON.stringify(item)}`)
      }
      return item
    })
    if (tools.length === 0) throw new ImportLocalError('import-boundary', 'import descriptor tools must not be empty')
    return tools
  }
  return [slug.replaceAll('-', '_')]
}

function digestMap(
  files: Record<string, string>,
  extras: readonly { readonly name: string; readonly payload: string }[],
): string {
  const hash = createHash('sha256')
  for (const relative of Object.keys(files).sort()) {
    hash.update(relative)
    hash.update('\0')
    hash.update(files[relative] ?? '')
    hash.update('\0')
  }
  for (const extra of extras) {
    hash.update(extra.name)
    hash.update('\0')
    hash.update(extra.payload)
    hash.update('\0')
  }
  return hash.digest('hex')
}
