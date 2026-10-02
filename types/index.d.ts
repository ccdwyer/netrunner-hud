export type Call = { id: string; tool: string; label: string; at: number; ms: number | null; isError: boolean; isSub: boolean }
// `test` is how sure a finished run's exit status would be the suite's, for a backgrounded test command.
export type Job = { id: string; label: string; at: number; test?: 'run' | 'run-cd' | 'unknown' }
export type Git = { branch: string; dirty: number; at: number }
export type TestRun = { label: string; ok: boolean; at: number; certain: boolean }
export type Meter = { ctxPct: number | null; usd: number | null; burn: number | null; startedAt: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'netrunner-hud': {
      calls: Call[]
      jobs: Job[]
      git: Git | null
      test: TestRun | null
      meter: Meter | null
    }
  }
}
