import type { CleanViewChecklist, CleanViewTask, CleanViewTaskStatus } from '../types'

export const MAX_NAME = 40
export const FALLBACK_NAME = 'Working on it'
export const FALLBACK_TITLE = 'Working on your request'
export const METER_CELLS = 10

const CODE_FILE =
  /\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|ps1|bat|cmd|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|md|mdx|html?|css|scss|sass|less|sql|xml|vue|svelte|astro|graphql|proto|tf|gradle|dart|lua|r|pl|ex|exs|zig)\b/gi

/**
 * The one cleaner every step name and job title passes through: no code, no
 * paths, no file names, one line, a capital first letter, at most 40 characters.
 */
export function cleanName(raw: unknown, fallback: string = FALLBACK_NAME): string {
  let text = typeof raw === 'string' ? raw : ''
  text = text.replace(/`[^`]*`/g, ' ').replace(/`/g, ' ')
  text = text
    .split(/\s+/)
    .filter(word => !word.includes('/') && !word.includes('\\'))
    .join(' ')
  text = text.replace(CODE_FILE, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/^[\s,.;:–—-]+/, '').trim()
  if (text === '') return fallback
  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (text.length <= MAX_NAME) return text
  const head = text.slice(0, MAX_NAME - 1)
  const space = head.lastIndexOf(' ')
  const cut = (space > 0 ? head.slice(0, space) : head).replace(/[\s,.;:–—-]+$/, '')
  return `${cut}…`
}

/** Fits a name into `width` cells, ending in "…" when it is cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text.padEnd(width)
  if (width === 1) return '…'
  return `${text.slice(0, width - 1)}…`
}

/** The 10-cell meter: filled to `percent`, or a moving sweep when `sweep` is a frame number. */
export function meter(percent: number, sweep?: number): string {
  if (sweep !== undefined) {
    const at = sweep % METER_CELLS
    let cells = ''
    for (let i = 0; i < METER_CELLS; i++) {
      const distance = (i - at + METER_CELLS) % METER_CELLS
      cells += distance < 3 ? '▓' : '░'
    }
    return cells
  }
  const filled = Math.max(0, Math.min(METER_CELLS, Math.round(clampPercent(percent) / 10)))
  return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled)
}

export function clampPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(Math.max(0, Math.min(100, n)))
}

/** "45s", "1m 12s", "1h 3m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function task(id: string, name: string, status: CleanViewTaskStatus): CleanViewTask {
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: false }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** A new job with placeholder steps, shown until the real plan arrives. */
export function newJob(now: number, title: string = FALLBACK_TITLE): CleanViewChecklist {
  return {
    title,
    phase: 'working',
    tasks: [
      task('placeholder-1', 'Understand your request', 'active'),
      task('placeholder-2', 'Plan the steps', 'upcoming'),
    ],
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
    isPlanned: false,
  }
}

function base(list: CleanViewChecklist | null, now: number): CleanViewChecklist {
  return list ?? newJob(now)
}

/** Keeps one active step at most, and starts the first upcoming one when none is. */
function settle(tasks: CleanViewTask[]): CleanViewTask[] {
  let seen = false
  const one = tasks.map(t => {
    if (t.status !== 'active') return t
    if (seen) return { ...t, status: 'upcoming' as const }
    seen = true
    return t
  })
  if (seen) return one
  const next = one.findIndex(t => t.status === 'upcoming')
  if (next === -1) return one
  return one.map((t, i) => (i === next ? { ...t, status: 'active' as const } : t))
}

/** plan_steps: every step laid out, the first one started. */
export function planSteps(list: CleanViewChecklist | null, names: readonly string[], now: number): CleanViewChecklist {
  const job = base(list, now)
  const tasks = names.map((name, i) => task(`step-${i + 1}`, name, i === 0 ? 'active' : 'upcoming'))
  return { ...job, tasks, isPlanned: true, phase: 'working', needsYouReason: null, stuckReason: null, isCollapsed: false, finishedAt: null }
}

/**
 * report_progress: steps before the reported one are checked off; at 100 the
 * step is checked off and the next starts; a name not in the plan is added
 * where the unfinished work begins.
 */
export function reportProgress(list: CleanViewChecklist | null, name: string, percent: number, now: number): CleanViewChecklist {
  const job = base(list, now)
  let tasks = [...job.tasks]
  let at = tasks.findIndex(t => sameName(t.name, name))
  if (at === -1) {
    const firstOpen = tasks.findIndex(t => t.status !== 'done')
    at = firstOpen === -1 ? tasks.length : firstOpen
    tasks.splice(at, 0, task(`step-${now}-${tasks.length + 1}`, name, 'active'))
  }
  const isFinished = percent >= 100
  tasks = tasks.map((t, i) => {
    if (i < at) return t.status === 'done' ? t : { ...t, status: 'done' as const, percent: 100 }
    if (i === at) return { ...t, status: isFinished ? ('done' as const) : ('active' as const), percent, hasReported: true }
    return t.status === 'active' ? { ...t, status: 'upcoming' as const } : t
  })
  return { ...job, tasks: settle(tasks) }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

const STATUS_OF: Record<Todo['status'], CleanViewTaskStatus> = {
  completed: 'done',
  in_progress: 'active',
  pending: 'upcoming',
}

/** TodoWrite: the to-do list becomes the plan, percents kept for steps it already had. */
export function fromTodos(list: CleanViewChecklist | null, todos: readonly Todo[], now: number): CleanViewChecklist {
  const job = base(list, now)
  const kept = job.isPlanned ? job.tasks : []
  const tasks = todos.map((todo, i) => {
    const name = cleanName(todo.content)
    const status = STATUS_OF[todo.status] ?? 'upcoming'
    const before = kept.find(t => sameName(t.name, name))
    return {
      id: `todo-${i + 1}`,
      name,
      status,
      percent: status === 'done' ? 100 : (before?.percent ?? 0),
      hasReported: before?.hasReported ?? false,
    }
  })
  return { ...job, tasks: settle(tasks), isPlanned: tasks.length > 0 || job.isPlanned }
}

/** TaskCreate: one more step; the first replaces the placeholders. */
export function addTask(list: CleanViewChecklist | null, id: string, name: string, now: number): CleanViewChecklist {
  const job = base(list, now)
  const tasks = job.isPlanned ? [...job.tasks] : []
  tasks.push(task(id, name, 'upcoming'))
  return { ...job, tasks: settle(tasks), isPlanned: true }
}

type TaskChange = {
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
  name?: string
}

/** TaskUpdate: a step started, finished, renamed or removed. */
export function updateTask(list: CleanViewChecklist | null, id: string, change: TaskChange, now: number): CleanViewChecklist {
  const job = base(list, now)
  if (change.status === 'deleted') {
    return { ...job, tasks: settle(job.tasks.filter(t => t.id !== id)) }
  }
  let tasks = job.tasks.map(t => {
    if (t.id !== id) return t
    const renamed = change.name ? { ...t, name: change.name } : t
    if (change.status === 'completed') return { ...renamed, status: 'done' as const, percent: 100 }
    if (change.status === 'in_progress') return { ...renamed, status: 'active' as const }
    if (change.status === 'pending') return { ...renamed, status: 'upcoming' as const }
    return renamed
  })
  if (change.status === 'in_progress') {
    tasks = tasks.map(t => (t.id !== id && t.status === 'active' ? { ...t, status: 'upcoming' as const } : t))
  }
  return { ...job, tasks: settle(tasks) }
}

/** Every step checked off. */
export function finishAll(tasks: readonly CleanViewTask[]): CleanViewTask[] {
  return tasks.map(t => ({ ...t, status: 'done' as const, percent: 100 }))
}

/** One calm sentence for an API error, by the kind Claude Code classifies it as. */
export function errorSentence(kind: string | null, details: string | null): string {
  const text = (details ?? '').toLowerCase()
  if (/too long|context|too many tokens/.test(text)) return 'type /compact and try again'
  if (/econn|enotfound|etimedout|network|fetch failed|socket|connection/.test(text)) return 'the internet connection dropped'
  switch (kind) {
    case 'rate_limit':
    case 'billing_error':
      return 'you hit your usage limit, try again a little later'
    case 'overloaded':
    case 'server_error':
      return "Claude's servers are busy, try again in a minute"
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'cloud_credential_error':
      return 'type /login'
    case 'network':
      return 'the internet connection dropped'
    default:
      return 'something went wrong, try again in a moment'
  }
}

/** Which of the 10 meter cells are lit: filled to `percent`, or a 3-cell sweep at frame `sweep`. */
export function meterCells(percent: number, sweep?: number): boolean[] {
  const cells: boolean[] = []
  if (sweep !== undefined) {
    const at = sweep % METER_CELLS
    for (let i = 0; i < METER_CELLS; i++) cells.push((i - at + METER_CELLS) % METER_CELLS < 3)
    return cells
  }
  const filled = Math.round(clampPercent(percent) / 10)
  for (let i = 0; i < METER_CELLS; i++) cells.push(i < filled)
  return cells
}

/** The whole job's progress: each step counts the same, the current one by its percent. */
export function overallPercent(tasks: readonly CleanViewTask[]): number {
  if (tasks.length === 0) return 0
  const sum = tasks.reduce((n, t) => n + (t.status === 'done' ? 100 : t.status === 'active' ? t.percent : 0), 0)
  return Math.round(sum / tasks.length)
}

/** "Step 2 of 4": the current step, or the last one finished. */
export function stepLabel(tasks: readonly CleanViewTask[]): string {
  const active = tasks.findIndex(t => t.status === 'active')
  const at = active === -1 ? tasks.filter(t => t.status === 'done').length : active + 1
  return `Step ${Math.max(1, at)} of ${Math.max(1, tasks.length)}`
}

const TITLE_STOPS = ['#F2994A', '#F06292', '#C86DD7', '#8E7CF0', '#6FA8FF'] as const

/** The colour of word `i` of `n` in the title's orange-to-blue fade. */
export function titleColor(i: number, n: number): string {
  if (n <= 1) return TITLE_STOPS[0]
  const at = Math.round((i / (n - 1)) * (TITLE_STOPS.length - 1))
  return TITLE_STOPS[Math.min(TITLE_STOPS.length - 1, Math.max(0, at))] ?? TITLE_STOPS[0]
}
