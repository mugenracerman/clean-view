import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { cleanName } from '../hooks/checklist'

const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'

const BAND = {
  plugin: 'clean-view',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const FOOTER = { plugin: 'clean-view', component: 'SessionMode', props: { modes: [] } } as const

const SESSION = { cwd: '.', surface: 'terminal', isInteractive: true } as const

/**
 * What a session answers beneath the plugin: its start, and the tool and command it registers.
 * Given `written`, the store is that object, so a test can read what the plugin saved.
 */
function session(on: On, stored: Record<string, unknown> = {}, written?: Record<string, unknown>) {
  if (written === undefined) mock.store(on, stored)
  else {
    Object.assign(written, stored)
    on('store.get', ($, e) => ({ value: written[e.key] }))
    on('store.set', ($, e) => {
      written[e.key] = e.value
      return { value: undefined }
    })
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__clean-view__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('classic.Notification', () => ({}))
  // What the engine draws beneath ours: its own drawing, as in a real session.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.render', { component: 'SessionMode' }, () => ({ type: 'engine', ref: 0 }))
  return mock.clock(on, { now: 1_000_000 })
}

const TODOS = [
  { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading your brand notes' },
  { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building the pricing section' },
  { content: 'Add the contact form', status: 'pending', activeForm: 'Adding the contact form' },
  { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing the footer' },
] as const

describe('names', () => {
  test('1. the cleaner strips code, paths and file names, and trims long names', async () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
    expect(cleanName('Update src/app/page.tsx with the new copy')).toBe('Update with the new copy')
    expect(cleanName('fix the   tests in utils.py')).toBe('Fix the tests in')
    expect(cleanName('`npm run build`')).toBe('Working on it')

    const long = 'Rewrite the whole onboarding flow so that new visitors understand the product faster'
    expect(long.length >= 80).toBe(true)
    const trimmed = cleanName(long)
    expect(trimmed.length <= 40).toBe(true)
    expect(trimmed.endsWith('…')).toBe(true)
    expect(trimmed).toBe('Rewrite the whole onboarding flow so…')
  })
})

describe('the checklist band', () => {
  test('2. a to-do list and a 60% report draw done, current, next and up next rows', async ($, on) => {
    session(on)
    on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
    await $.session.start(SESSION)

    await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
    await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 60 })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /^✓ Read your brand notes\s+━{10}\s+Done$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^● Build the pricing section\s+━{10}\s+60%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^○ Add the contact form\s+━{10}\s+Next$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^○ Polish the footer\s+━{10}\s+Up next$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Step 2 of 4\s+40%$/ })).toBeDefined()
      await ui.unmount()

      const footer = await $.ui.mount({ ...FOOTER, surface })
      expect(await footer.find({ text: /Clean View: On/ })).toBeDefined()
      await footer.unmount()
    }
  })

  test('3. a permission prompt shows Needs you', async ($, on) => {
    session(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })

    await $.classic.Notification({
      message: 'Claude needs your permission to use Bash',
      notification_type: 'permission_prompt',
    })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Claude needs your OK to continue/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^‖ Read your brand notes/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('4. /simple off hides the band and the footer toggle says Off', async ($, on) => {
    session(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })

    const hidden = await $.ui.mount({
      plugin: 'clean-view',
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await hidden.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })
    await hidden.unmount()

    const before = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await before.find({ type: 'Text', text: /Read your brand notes/ })).toBeDefined()
    await before.unmount()

    await $.command.run({
      command: 'simple',
      args: 'off',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })


    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Read your brand notes/ })).toBeUndefined()
      await ui.unmount()

      const footer = await $.ui.mount({ ...FOOTER, surface })
      expect(await footer.find({ text: /Clean View: Off/ })).toBeDefined()
      await footer.unmount()
    }

    await $.command.run({
      command: 'simple',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
    const back = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
    expect(await back.find({ text: /Clean View: On/ })).toBeDefined()
    await back.unmount()
  })

  test('4b. the saved choice survives a restart', async ($, on) => {
    session(on, { cleanViewEnabled: false })
    await $.session.start(SESSION)
    await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /Read your brand notes/ })).toBeUndefined()
    await band.unmount()

    const terminal = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
    expect(await terminal.find({ text: /Clean View: Off/ })).toBeDefined()
    await terminal.press({ key: 'clean-view-toggle' })
    expect(await terminal.find({ text: /Clean View: On/ })).toBeDefined()
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
    expect(await desktop.find({ text: /Clean View: On/ })).toBeDefined()
    await desktop.press({ key: 'clean-view-toggle' })
    expect(await desktop.find({ text: /Clean View: Off/ })).toBeDefined()
    await desktop.press({ key: 'clean-view-toggle' })
    expect(await desktop.find({ text: /Clean View: On/ })).toBeDefined()
    await desktop.unmount()

    const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /Read your brand notes/ })).toBeDefined()
    await after.unmount()
  })

  test('4c. /clean-view on and off flip it and keep isOn for a dashboard', async ($, on) => {
    const stored: Record<string, unknown> = {}
    session(on, {}, stored)
    await $.session.start(SESSION)
    expect(stored.isOn).toBe(true)
    const run = (args: string) =>
      $.command.run({ command: 'clean-view', args, origin: { kind: 'plugin', name: 'damons-tools' }, presentation: { isFullscreen: false, columns: 100 } })

    await run('off')
    expect(stored.isOn).toBe(false)
    expect(stored.cleanViewEnabled).toBe(false)
    const footer = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
    expect(await footer.find({ text: /Clean View: Off/ })).toBeDefined()
    await footer.unmount()

    await run('on')
    expect(stored.isOn).toBe(true)
    expect((await run('')).text).toContain('Clean View is on')
  })
})

describe('the plan', () => {
  test('5. plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
    session(on)
    await $.session.start(SESSION)

    const planned = await $.tool.call({
      tool: PLAN,
      steps: ['Read your brand notes', 'Build the pricing section', 'Polish the footer'],
    })
    expect(planned.result).toBe('Planned 3 steps. The first one has started.')

    const reported = await $.tool.call({ tool: PROGRESS, task: 'Read your brand notes', percent: 100 })
    expect(reported.result).toBe('Progress noted: 100%.')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^✓ Read your brand notes\s+━{10}\s+Done$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^● Build the pricing section\s+━{10}\s+Working$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^○ Polish the footer\s+━{10}\s+Next$/ })).toBeDefined()
    await ui.unmount()

    const clamped = await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 250 })
    expect(clamped.result).toBe('Progress noted: 100%.')
  })

  test('6. tools are denied before a plan exists and allowed after', async ($, on) => {
    session(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'file contents' }))
    on('tool.call', { tool: 'ToolSearch' }, () => ({ result: { matches: [], query: '' } }))
    await $.session.start(SESSION)

    const denied = await $.tool.call({ tool: 'Read', file_path: 'notes.md' })
    expect(denied.deny ?? denied.text ?? '').toContain('plan_steps')

    const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:plan_steps', max_results: 1 })
    expect(search.deny).toBeUndefined()

    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Write the summary'] })

    const allowed = await $.tool.call({ tool: 'Read', file_path: 'notes.md' })
    expect(allowed.deny).toBeUndefined()
    expect(allowed.result).toBe('file contents')
  })
})

describe('a job from start to finish', () => {
  test('7. placeholders, a Haiku name, All done, then one line after 5 seconds; Esc stops', async ($, on) => {
    const clock = session(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('model.complete', () => ({
      value: {
        isAnswered: true,
        text: 'Build my landing page',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }))
    await $.session.start(SESSION)

    await $.turn.start({ text: 'Can you build me a landing page for my bakery?', turnId: 'turn-1' })
    await clock.settle()
    const early = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await early.find({ type: 'Text', text: /^● Understand your request/ })).toBeDefined()
    expect(await early.find({ type: 'Text', text: /^○ Plan the steps/ })).toBeDefined()
    expect(await early.find({ type: 'Text', text: /^✦ Build my landing page$/ })).toBeDefined()
    expect(await early.find({ type: 'Text', text: /^ 0s$/ })).toBeDefined()
    await early.unmount()

    await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
    await clock.advance(72_000)
    await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 100 })
    await $.turn.complete({ answer: 'Done!', durationMs: 72_000, isAborted: false, turnId: 'turn-1', reason: 'answer' })

    const done = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await done.find({ type: 'Text', text: /✓ All done · Build my landing page/ })).toBeDefined()
    expect(await done.find({ type: 'Text', text: /took 1m 12s/ })).toBeDefined()
    expect(await done.find({ type: 'Text', text: /Read your brand notes/ })).toBeDefined()
    await clock.advance(5_000)
    expect(await done.find({ type: 'Text', text: /✓ All done/ })).toBeDefined()
    expect(await done.find({ type: 'Text', text: /Read your brand notes/ })).toBeUndefined()
    await done.unmount()

    await $.turn.start({ text: 'Now add a menu page', turnId: 'turn-2' })
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: true, turnId: 'turn-2', reason: 'aborted' })
    const stopped = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await stopped.find({ type: 'Text', text: /■ Stopped · .* · you pressed Esc/ })).toBeDefined()
    await stopped.unmount()
  })
})
