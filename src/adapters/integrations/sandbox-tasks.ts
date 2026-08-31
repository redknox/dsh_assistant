import {
  SANDBOX_MAX_TASK_BODY_CHARS,
  SANDBOX_MAX_TASK_TITLE_CHARS,
  listConfinedTextFiles,
  readConfinedText,
  writeConfinedText,
} from '../../domain/files/confined-root.js'
import type { TaskItem, TasksProvider } from '../../domain/integrations/hub.js'
import {
  IntegrationError,
  MAX_PAGE_SIZE,
  throwIfAborted,
  type Availability,
  type Page,
  type PageQuery,
  type ProposedMutation,
} from '../../domain/integrations/types.js'

const TASKS_PREFIX = 'tasks'

function pageTasks(items: readonly TaskItem[], query: PageQuery): Page<TaskItem> {
  throwIfAborted('tasks', query.signal)
  const limit = query.limit === undefined ? 10 : query.limit
  if (!Number.isInteger(limit) || limit < 1) {
    throw new IntegrationError('tasks', 'invalid_request', 'limit must be a positive integer')
  }
  const size = Math.min(limit, MAX_PAGE_SIZE)
  const start = query.cursor ? Number.parseInt(query.cursor, 10) : 0
  if (!Number.isFinite(start) || start < 0) {
    throw new IntegrationError('tasks', 'invalid_request', 'cursor is invalid')
  }
  const slice = items.slice(start, start + size)
  const next = start + size < items.length ? String(start + size) : undefined
  return next ? { items: slice, nextCursor: next } : { items: slice }
}

function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'task'
}

function renderTask(title: string, status: TaskItem['status']): string {
  return `---\nstatus: ${status}\n---\n# ${title}\n`
}

function parseTask(relative: string, content: string): TaskItem {
  const status = /(?:^|\n)status:\s*(done|open)\b/i.exec(content)?.[1]?.toLowerCase() === 'done' ? 'done' : 'open'
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return { id: relative, title: heading || relative.slice(TASKS_PREFIX.length + 1).replace(/\.md$/, ''), status }
}

function requireBoundedTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) throw new IntegrationError('tasks', 'invalid_request', 'title is required')
  if (trimmed.length > SANDBOX_MAX_TASK_TITLE_CHARS) {
    throw new IntegrationError('tasks', 'invalid_request', `task title exceeds the ${SANDBOX_MAX_TASK_TITLE_CHARS} character bound`)
  }
  return trimmed
}

function wrap<T>(op: () => T): T {
  try {
    return op()
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new IntegrationError('tasks', 'invalid_request', message)
  }
}

/** Tasks stored as markdown under <sandbox>/tasks/. */
export function createSandboxTasksProvider(root: string): TasksProvider {
  return {
    capability: 'tasks',
    availability(): Availability {
      return { available: true, provider: 'sandbox' }
    },
    async listTasks(query: PageQuery): Promise<Page<TaskItem>> {
      throwIfAborted('tasks', query.signal)
      const items = wrap(() => listConfinedTextFiles(root, TASKS_PREFIX, '.md').map((relative) => (
        parseTask(relative, readConfinedText(root, relative))
      )))
      return pageTasks(items, query)
    },
    async proposeCreateTask(input: { title: string }, signal?: AbortSignal): Promise<ProposedMutation<TaskItem>> {
      throwIfAborted('tasks', signal)
      const title = requireBoundedTitle(input.title)
      const draft: TaskItem = { id: `${TASKS_PREFIX}/${slugify(title)}.md`, title, status: 'open' }
      return { trust: 'propose', summary: `Propose task "${draft.title}"`, draft }
    },
    async createTask(input: { title: string }, signal?: AbortSignal): Promise<TaskItem> {
      throwIfAborted('tasks', signal)
      const title = requireBoundedTitle(input.title)
      const body = renderTask(title, 'open')
      if (body.length > SANDBOX_MAX_TASK_BODY_CHARS) {
        throw new IntegrationError('tasks', 'invalid_request', `task content exceeds the ${SANDBOX_MAX_TASK_BODY_CHARS} character bound`)
      }
      return wrap(() => {
        const existing = new Set(listConfinedTextFiles(root, TASKS_PREFIX, '.md'))
        let slug = slugify(title)
        let relative = `${TASKS_PREFIX}/${slug}.md`
        let n = 2
        while (existing.has(relative)) {
          relative = `${TASKS_PREFIX}/${slug}-${n}.md`
          n += 1
        }
        writeConfinedText(root, relative, body)
        return { id: relative, title, status: 'open' as const }
      })
    },
  }
}
