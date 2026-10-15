// Defaults for the stored state. The atoms and every helper that takes `$` live in register.tsx:
// the engine reads atoms and follows `$` only within the one hooks module file.
import type { Main, Roster, Usage, View } from '../types'

export const SCHEMA_VERSION = 1
export const DEFAULT_MAIN: Main = { model: '', effort: '', steps: 0, isRunning: false, activity: '' }
export const DEFAULT_USAGE: Usage = { pct: null, tokens: null, window: 0 }
export const DEFAULT_VIEW: View = { expanded: null, gateOpen: null, layout: null }
export const DEFAULT_ROSTER: Roster = { architectTypes: [] }
