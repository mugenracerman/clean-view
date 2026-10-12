import { atom, read, update } from 'claude-code'
import type { ModelCompleteRequest, ModelCompleteResult, On, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../types'
import {
  addTask,
  clampPercent,
  cleanName,
  errorSentence,
  finishAll,
  fit,
  formatDuration,
  fromTodos,
  meterCells,
  overallPercent,
  stepLabel,
  titleColor,
  newJob,
  planSteps,
  reportProgress,
  updateTask,
} from './checklist'

type Checklist = CleanViewChecklist | null

export const PLAN_TOOL = 'mcp__clean-view__plan_steps'
export const PROGRESS_TOOL = 'mcp__clean-view__report_progress'

const STORE_KEY = 'cleanViewEnabled'
const TICK_MS = 250
const COLLAPSE_MS = 5000
const FAILS_BEFORE_STUCK = 3
const LABEL_CELLS = 7

// The footer toggle's colours, the same as Prompt Upgrade's and Auto Model's.
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'

// The progress box's colours.
const PINK = '#E85D9E'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const SWEEP = '#6C78D8'
const FRAME: Record<CleanViewChecklist['phase'], string> = {
  working: PINK,
  'needs-you': AMBER,
  stuck: AMBER,
  stopped: MUTED,
  done: GREEN,
}

const ALWAYS_ALLOWED = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  PLAN_TOOL,
  PROGRESS_TOOL,
])

const NEEDS_OK = 'Claude needs your OK to continue'
const HAS_QUESTION = 'Claude has a question for you'
const WAITING_FOR_REPLY = 'Claude is waiting for your reply'
const SAID_NO = 'you said no to a step, so Claude paused'
const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
const REFUSED = "Claude couldn't help with that request"

const REJECTED = /doesn't want to proceed|was rejected|user (?:rejected|denied|declined)|permission (?:was )?denied/i

const GATE_MESSAGE =
  `Clean View: lay out the plan first. Call ${PLAN_TOOL} with 2 to 8 plain-English step names ` +
  '(load it with ToolSearch if it is deferred), then try this again.'

const GUIDE = [
  '# Clean View',
  'The person is using Clean View. They do not see tool calls, file changes or command output: only your written replies and a checklist of your plan above the prompt.',
  `- For every request, even a quick question, call \`${PLAN_TOOL}\` first, before any other tool. Load it with ToolSearch if it is deferred. Other tools are refused until a plan exists.`,
  '- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
  `- Call \`${PROGRESS_TOOL}\` with the step's name and a percent as real progress happens, and with 100 the moment a step finishes; the next step then starts by itself.`,
  '- If this session has TodoWrite or TaskCreate, you may use your to-do list as the plan instead. The same naming rules apply.',
].join('\n')

const enabled = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklist = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tick = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

// The module's own variables start over on a hot reload; everything drawn lives in $.state.
let ticker: Timer | undefined
let failures = 0
let lastApiError: { kind: string | null; details: string | null } | null = null

const isLive = (list: Checklist) => list !== null && (list.phase === 'working' || list.phase === 'needs-you')

/**
 * What the shared helpers need from the engine, as closures each hook builds
 * over its own $ (a hooks module never passes $ itself around).
 */
type IO = {
  write: (fn: (list: Checklist) => Checklist) => Promise<unknown>
  isLive: () => Promise<boolean>
  every: (ms: number, fn: () => void) => Timer
  bump: () => Promise<unknown>
}

/** The 250ms clock runs only while a job is working or waiting on the person. */
async function keepTicking(io: IO): Promise<void> {
  if (ticker !== undefined || !(await io.isLive())) return
  ticker = io.every(TICK_MS, () => {
    void (async () => {
      if (!(await io.isLive())) {
        ticker?.cancel()
        ticker = undefined
        return
      }
      await io.bump()
    })()
  })
}

async function change(io: IO, fn: (list: Checklist) => Checklist): Promise<void> {
  await io.write(fn)
  await keepTicking(io)
}

const whileOpen = (fn: (list: CleanViewChecklist) => CleanViewChecklist) => (list: Checklist) =>
  list === null || list.finishedAt !== null ? list : fn(list)

const backToWork = (list: CleanViewChecklist): CleanViewChecklist => ({
  ...list,
  phase: 'working',
  needsYouReason: null,
  stuckReason: null,
})

const toastFor = (value: boolean) =>
  value ? 'Clean View is on: tool details are hidden' : 'Clean View is off: showing everything'

/** Asks Haiku for a 2 to 6 word name, in the background; a newer job wins. */
function nameJob(
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>,
  write: IO['write'],
  request: string,
  startedAt: number,
): void {
  void (async () => {
    const reply = await complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 30,
      timeoutMs: 20000,
      system:
        'You name tasks for a progress checklist read by non-technical people. Reply with the name only: 2 to 6 plain English words that start with a verb, like "Build my landing page". No file names, code, quotes or ending punctuation.',
      prompt: `Name this request:\n\n${request.slice(0, 2000)}`,
    })
    if (!reply.isAnswered) return
    const line = (reply.text.split('\n').find(l => l.trim() !== '') ?? '').replace(
      /^[\s"'“”‘’*#-]+|[\s"'“”‘’*.!?:]+$/g,
      '',
    )
    const title = cleanName(line.split(/\s+/).slice(0, 6).join(' '), '')
    if (title === '') return
    await write(list => (list !== null && list.startedAt === startedAt ? { ...list, title } : list))
  })().catch(() => undefined)
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }
    const stored = await $.store.get(STORE_KEY)
    await $.state.set({ plugin: 'clean-view', key: 'cleanViewEnabled' }, stored !== false)
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job before you start, in order: 2 to 8 short names in plain English a non-technical person understands, each under 40 characters and starting with a verb ("Build the pricing section"). Never put file paths, file names, commands, code or tool names in a step name. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 8,
            description: 'The step names, in order.',
          },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        "Report progress on the current step: its name as planned and how far along it is, 0 to 100. Report 100 the moment a step finishes; the next one starts by itself. Reporting a later step checks off the ones before it, and a name that isn't in the plan becomes a new step.",
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The step name, as planned.' },
          percent: { type: 'number', minimum: 0, maximum: 100, description: 'How far along the step is.' },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (with no argument, flip it)',
      argumentHint: '[on|off]',
      immediate: true,
    })
    await keepTicking(io)
    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }
    const arg = e.args.trim().toLowerCase()
    const current = await read($, enabled)
    const want = arg === 'on' ? true : arg === 'off' ? false : arg === '' ? !current : null
    if (want === null) return { text: 'Use /simple on, /simple off, or just /simple to flip it.' }
    await $.state.set({ plugin: 'clean-view', key: 'cleanViewEnabled' }, want)
    await $.store.set(STORE_KEY, want)
    $.ui.toast(toastFor(want))
    await keepTicking(io)
    return { text: want ? 'Clean View is on.' : 'Clean View is off. Everything is visible again.' }
  })

  // A toggle in the prompt footer, left of the other mods' toggles and the
  // engine's mode labels (all drawn by `next`); a click flips Clean View.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const label = `Clean View: ${isOn ? 'On' : 'Off'}`
    const flip = async () => {
      const io: IO = {
        write: fn => update($, checklist, fn),
        isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
        every: (ms, fn) => $.clock.every(ms, fn),
        bump: () => update($, tick, n => n + 1),
      }
      const value = await update($, enabled, one => !one)
      await $.store.set(STORE_KEY, value)
      $.ui.toast(toastFor(value))
      await keepTicking(io)
    }
    const theirs = await next(e).catch(() => null)
    return (
      <Box flexDirection="row" columnGap={1}>
        {e.surface === 'terminal' ? (
          <Button key="clean-view-toggle" plain onPress={flip}>
            <Text backgroundColor={LINE} color={isOn ? TEXT : MUTED}>{` ${label} `}</Text>
          </Button>
        ) : (
          <Button key="clean-view-toggle" label={label} plain onPress={flip} />
        )}
        {theirs}
      </Box>
    )
  })

  // While Clean View is on, every request gets a plain-English plan first.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabled))) return composed
    return {
      ...composed,
      sections: [...composed.sections, { id: 'clean-view:plain-steps', text: GUIDE, scope: 'session' as const }],
    }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }
    if (e.agentId !== undefined) return { result: 'Only the main agent keeps the plan. Carry on.' }
    const raw = (e as { steps?: unknown }).steps
    const names = Array.isArray(raw) ? raw.slice(0, 8).map(step => cleanName(step)) : []
    if (names.length === 0) {
      return { deny: 'plan_steps needs `steps`: a list of 2 to 8 short plain-English step names.' }
    }
    const now = await $.clock.now()
    failures = 0
    await change(io, list => planSteps(list, names, now))
    return { result: `Planned ${names.length} steps. The first one has started.` }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }
    if (e.agentId !== undefined) return { result: 'Only the main agent keeps the plan. Carry on.' }
    const input = e as { task?: unknown; percent?: unknown }
    const percent = clampPercent(input.percent)
    const name = cleanName(input.task)
    const now = await $.clock.now()
    await change(io, list => reportProgress(list, name, percent, now))
    return { result: `Progress noted: ${percent}%.` }
  })

  // The gate, "Needs you" for questions, and the checklist built from what Claude already does.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    if (tool === PLAN_TOOL || tool === PROGRESS_TOOL) return next(e)
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }

    const isOn = await read($, enabled)
    const before = await read($, checklist)
    if (isOn && !ALWAYS_ALLOWED.has(tool) && !(before?.isPlanned ?? false)) {
      return { deny: GATE_MESSAGE }
    }

    if (before?.phase === 'needs-you') await change(io, whileOpen(backToWork))
    if (tool === 'AskUserQuestion') {
      await change(io, whileOpen(list => ({ ...list, phase: 'needs-you', needsYouReason: HAS_QUESTION })))
    }

    const ran = await next(e)

    const now = await $.clock.now()
    const after = await read($, checklist)
    if (after?.phase === 'needs-you' && after.needsYouReason !== WAITING_FOR_REPLY) {
      await change(io, whileOpen(backToWork))
    }
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
      if (REJECTED.test(ran.text ?? '')) {
        failures = 0
        await change(io, whileOpen(list => ({ ...list, phase: 'stuck', stuckReason: SAID_NO, needsYouReason: null })))
      } else {
        failures += 1
        if (failures >= FAILS_BEFORE_STUCK) {
          await change(io, whileOpen(list => ({ ...list, phase: 'stuck', stuckReason: KEEPS_FAILING })))
        }
      }
      return ran
    }

    failures = 0
    if ((await read($, checklist))?.phase === 'stuck') await change(io, whileOpen(backToWork))

    if (e.tool === 'TodoWrite') {
      const todos = e.todos
      await change(io, list => fromTodos(list, todos, now))
    } else if (e.tool === 'TaskCreate') {
      const made = ran.result as { task?: { id?: unknown } } | undefined
      const id = typeof made?.task?.id === 'string' ? made.task.id : `task-${now}`
      const name = cleanName(e.subject)
      await change(io, list => addTask(list, id, name, now))
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject } = e
      const name = subject === undefined ? undefined : cleanName(subject)
      await change(io, list => updateTask(list, taskId, { status, name }, now))
    }
    return ran
  })

  // A permission prompt or a question for the person.
  on('classic.Notification', async ($, e, next) => {
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      const reason = e.notification_type === 'permission_prompt' ? NEEDS_OK : HAS_QUESTION
      await change(io, whileOpen(list => ({ ...list, phase: 'needs-you', needsYouReason: reason })))
    }
    return next(e)
  })

  // The kind of API error, which turn.complete does not carry.
  on('classic.StopFailure', async ($, e, next) => {
    lastApiError = { kind: e.error, details: e.error_details ?? null }
    const list = await read($, checklist)
    if (list?.phase === 'stuck' && list.finishedAt !== null) {
      const stuckReason = errorSentence(e.error, e.error_details ?? null)
      await update($, checklist, l => (l === null ? l : { ...l, stuckReason }))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }
    const text = e.text.trim()
    const list = await read($, checklist)
    const isOn = await read($, enabled)
    failures = 0
    lastApiError = null
    const isRealPrompt = text !== '' && !text.startsWith('/')

    if (isRealPrompt && isOn && list?.phase !== 'needs-you') {
      const now = await $.clock.now()
      await change(io, () => newJob(now))
      nameJob(request => $.model.complete(request), io.write, text, now)
    } else if (list !== null && (list.phase === 'needs-you' || list.finishedAt === null)) {
      // The person replied, or the job goes on.
      await change(io, l => (l === null ? l : { ...backToWork(l), finishedAt: null, isCollapsed: false }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const list = await read($, checklist)
    if (list === null || list.finishedAt !== null) return next(e)
    const io: IO = {
      write: fn => update($, checklist, fn),
      isLive: async () => (await read($, enabled)) && isLive(await read($, checklist)),
      every: (ms, fn) => $.clock.every(ms, fn),
      bump: () => update($, tick, n => n + 1),
    }

    const now = await $.clock.now()
    let outcome: CleanViewChecklist
    if (e.reason === 'error') {
      const reason = errorSentence(lastApiError?.kind ?? null, lastApiError?.details ?? null)
      outcome = { ...list, phase: 'stuck', stuckReason: reason, needsYouReason: null, finishedAt: now }
    } else if (e.reason === 'refusal') {
      outcome = { ...list, phase: 'stuck', stuckReason: REFUSED, needsYouReason: null, finishedAt: now }
    } else if (e.reason === 'aborted') {
      outcome =
        list.stuckReason === SAID_NO
          ? { ...list, phase: 'stuck', needsYouReason: null, finishedAt: now }
          : { ...list, phase: 'stopped', needsYouReason: null, stuckReason: null, finishedAt: now }
    } else if (list.isPlanned && list.tasks.some(t => t.status !== 'done')) {
      outcome = { ...list, phase: 'needs-you', needsYouReason: WAITING_FOR_REPLY, stuckReason: null }
    } else {
      outcome = {
        ...list,
        phase: 'done',
        tasks: finishAll(list.tasks),
        needsYouReason: null,
        stuckReason: null,
        finishedAt: now,
      }
      $.clock.after(COLLAPSE_MS, () => {
        void update($, checklist, l =>
          l !== null && l.phase === 'done' && l.finishedAt === now ? { ...l, isCollapsed: true } : l,
        )
      })
    }
    await change(io, () => outcome)
    return next(e)
  })

  // Hide the technical rows while Clean View is on; Claude's replies stay.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // The checklist band; the on/off toggle lives in the prompt footer.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const isOn = await read($, enabled)
    const list = isOn ? await read($, checklist) : null
    // Nothing to show: leave the band to whatever else draws there.
    if (list === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const frame = list.phase === 'working' ? await read($, tick) : 0
    const now = await $.clock.now()
    // Whatever else draws in the band (other mods) stays beneath ours. The engine
    // refuses its own drawing under a Box with a width, so the outer Box has none.
    const below = await next(e).catch(() => null)
    const width = Math.max(24, e.props.bodyColumns)

    // The box: a coloured frame, the job's name and time, the overall bar, then the steps.
    const inner = Math.max(20, width - 4)
    const elapsed = formatDuration((list.finishedAt ?? now) - list.startedAt)
    const words = list.title.split(' ')

    const title = (
      <Text bold>
        {words.map((word, i) => (
          <Text color={titleColor(i, words.length)}>{(i === 0 ? '' : ' ') + word}</Text>
        ))}
      </Text>
    )

    const headline = (() => {
      switch (list.phase) {
        case 'working':
          return (
            <Text wrap="truncate-end">
              <Text color={PINK}>✳ </Text>
              {title}
            </Text>
          )
        case 'needs-you':
          return (
            <Text wrap="truncate-end">
              <Text inverse bold color={AMBER}>
                {' Needs you '}
              </Text>
              <Text> {list.needsYouReason ?? NEEDS_OK}</Text>
            </Text>
          )
        case 'stuck':
          return (
            <Text wrap="truncate-end" color={AMBER}>
              ⚠ Stuck: {list.stuckReason ?? KEEPS_FAILING}
            </Text>
          )
        case 'stopped':
          return (
            <Text wrap="truncate-end">
              <Text bold>■ Stopped</Text>
              <Text color={MUTED}> · {list.title} · you pressed Esc</Text>
            </Text>
          )
        case 'done':
          return (
            <Text wrap="truncate-end">
              <Text bold color={GREEN}>
                ✓ All done
              </Text>
              <Text color={MUTED}> · {list.title}</Text>
            </Text>
          )
      }
    })()
    const timeText = list.phase === 'done' ? `took ${elapsed}` : elapsed
    const header = (
      <Box flexDirection="row" justifyContent="space-between" width={inner}>
        <Box flexShrink={1}>{headline}</Box>
        <Text color={MUTED}>{' ' + timeText}</Text>
      </Box>
    )

    // Finished and five seconds old: one line.
    if (list.phase === 'done' && list.isCollapsed) {
      return (
        <Box flexDirection="column">
          <Box paddingX={2} width={width}>
            {header}
          </Box>
          {below}
        </Box>
      )
    }

    const accent = list.phase === 'done' ? GREEN : PINK
    const percent = overallPercent(list.tasks)
    const steps = stepLabel(list.tasks)
    const barWidth = Math.max(4, inner - steps.length - 1 - 5)
    const filled = Math.round((barWidth * percent) / 100)
    const overall = (
      <Text wrap="truncate-end">
        <Text color={MUTED}>{steps + ' '}</Text>
        <Text backgroundColor={accent}>{' '.repeat(filled)}</Text>
        <Text backgroundColor={LINE}>{' '.repeat(barWidth - filled)}</Text>
        <Text bold color={accent}>
          {` ${percent}%`.padStart(5)}
        </Text>
      </Text>
    )

    const cells = (lit: boolean[], color: string) =>
      lit.map(isLit => <Text backgroundColor={isLit ? color : LINE}> </Text>)

    const nameWidth = Math.max(6, Math.min(44, inner - 2 - 2 - 10 - 2 - LABEL_CELLS))
    const firstUpcoming = list.tasks.findIndex(t => t.status === 'upcoming')
    const row = (t: CleanViewTask, i: number) => {
      const name = fit(t.name, nameWidth)
      if (t.status === 'done') {
        return (
          <Text wrap="truncate-end">
            <Text color={GREEN}>✓ </Text>
            <Text color={MUTED}>{name}</Text>
            {'  '}
            {cells(meterCells(100), GREEN)}
            <Text color={MUTED}>{'  Done'}</Text>
          </Text>
        )
      }
      if (t.status === 'active') {
        const isWaiting = list.phase === 'needs-you'
        const lit = t.hasReported ? meterCells(t.percent) : meterCells(0, frame)
        return (
          <Text wrap="truncate-end">
            <Text color={isWaiting ? AMBER : PINK}>{isWaiting ? '‖ ' : '● '}</Text>
            <Text bold>{name}</Text>
            {'  '}
            {cells(lit, t.hasReported ? PINK : SWEEP)}
            <Text bold color={PINK}>
              {'  ' + (t.hasReported ? `${t.percent}%` : 'Working')}
            </Text>
          </Text>
        )
      }
      return (
        <Text wrap="truncate-end">
          <Text color={MUTED}>{'○ ' + name}</Text>
          {'  '}
          {cells(meterCells(0), LINE)}
          <Text color={MUTED}>{'  ' + (i === firstUpcoming ? 'Next' : 'Up next')}</Text>
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={FRAME[list.phase]} paddingX={1} width={width}>
          {header}
          {overall}
          {list.tasks.map(row)}
        </Box>
        {below}
      </Box>
    )
  })
}
