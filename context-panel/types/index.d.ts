// Plain-data snapshots the panel draws from.

export type LimitReading = { kind: string; percentUsed: number; resetsAt?: string }

export type Measure = {
  tokens?: number
  window: number
  percent?: number
  limits: LimitReading[]
  // True when `limits` is the last non-empty reading, kept because the latest measurement had none.
  limitsAreOld?: boolean
  costUsd?: number
}

export type CategoryRow = { name: string; tokens: number; color: string; kind: string }

export type ServerRow = { name: string; tokens: number; tools: number }

// One element of a category's composition: a skill, a server, a file, an agent.
export type DetailRow = { name: string; tokens: number; note?: string }

export type DetailKey = 'skills' | 'mcp' | 'memory' | 'agents'

// A skill whose full text entered the conversation: how many times, and the
// characters of all those texts together.
export type LoadedSkill = { name: string; chars: number; times: number }

export type Breakdown = {
  detail: 'summary' | 'full'
  takenAt: number
  // Context fill when the breakdown was taken, to tell when it went stale.
  tokensAtTake?: number
  totalTokens: number
  maxTokens: number
  autoCompactThreshold?: number
  categories: CategoryRow[]
  servers: ServerRow[]
  skillsTokens?: number
  memoryTokens: number
  details: Record<DetailKey, DetailRow[]>
}

declare module 'claude-code' {
  interface PluginState {
    'context-panel': {
      measure: Measure | null
      breakdown: Breakdown | null
      busy: boolean
      // Name of the category whose composition is open, if any.
      expanded: string | null
      loaded: LoadedSkill[]
    }
  }
}
