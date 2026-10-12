import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'

// One entry point; more mods can be registered here beside Clean View.
export const register: Register = on => {
  registerCleanView(on)
}
