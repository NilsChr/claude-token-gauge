export type Tokens = { fresh: number; cached: number; out: number }

export type Gauge = {
  // Session the turn figures belong to ($.session.usage().startedAt).
  startedAt: number
  context: { tokens?: number; window: number; percent?: number } | null
  weekly: { percent: number } | null
  last: Tokens | null
  session: Tokens
}

declare module 'claude-code' {
  interface PluginState {
    'token-gauge': { gauge: Gauge }
  }
}
