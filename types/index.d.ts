// Clean View's shared state, readable by other mods under the 'clean-view' key.

export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  /** 0 to 100. */
  percent: number
  /** True once Claude has reported a percent for this step. */
  hasReported: boolean
}

export type CleanViewPhase = 'working' | 'needs-you' | 'stuck' | 'stopped' | 'done'

export type CleanViewChecklist = {
  /** The job's name in 2 to 6 plain words. */
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  needsYouReason: string | null
  stuckReason: string | null
  /** Milliseconds since the epoch. */
  startedAt: number
  finishedAt: number | null
  /** True once a finished job has shrunk to one line. */
  isCollapsed: boolean
  /** True once a real plan replaced the placeholder steps. */
  isPlanned: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist | null
      tick: number
    }
  }
}
