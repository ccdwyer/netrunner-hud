import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Call, Git, Job, Meter, TestRun } from '../types'
import { bar, clockText, gaugeFrame, headerFrame, scopeFrame, testOutcome, toolColor } from './gfx'

const PANE = 'netrunner-hud'
const FRAME_MS = 33
const SAMPLE_MS = 100
const METER_MS = 1000
const GIT_MS = 5000
const GAUGE_COLS = 24
const BAND_ROWS = 9
const MIN_RASTER_WIDTH = 60
const MAX_CALLS = 60

const calls = atom({ plugin: 'netrunner-hud', key: 'calls' } as const, [])
const jobs = atom({ plugin: 'netrunner-hud', key: 'jobs' } as const, [])
const git = atom({ plugin: 'netrunner-hud', key: 'git' } as const, null)
const test = atom({ plugin: 'netrunner-hud', key: 'test' } as const, null)
const meter = atom({ plugin: 'netrunner-hud', key: 'meter' } as const, null)

// Animation state lives in the module: it is rebuilt every frame, and a reload
// only costs a few seconds of oscilloscope history.
let frameTimer: Timer | null = null
let meterTimer: Timer | null = null
let gitTimer: Timer | null = null
let frame = 0
let drawing = false
let meterBusy = false
let gitBusy = false
let misses = 0
let tokens = 0
let sampledAt = 0
let smoothed = 0
let peak = 20
const samples: number[] = []
const dims = { width: 100, scopeCols: 75 }
let meterNow: Meter | null = null

const isLive = () => frameTimer !== null
// True while the HUD pane is open: data readings (usage, git) keep coming even where no raster animates.
const dataOn = () => meterTimer !== null

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
const base = (p: unknown) => String(p ?? '').split('/').pop() ?? ''

function labelOf(e: { tool: string; [k: string]: unknown }): string {
  if (e.tool === 'Bash') return short(String(e.command ?? ''), 48)
  if (typeof e.file_path === 'string') return base(e.file_path)
  if (typeof e.notebook_path === 'string') return base(e.notebook_path)
  if (typeof e.pattern === 'string') return short(e.pattern, 40)
  if (typeof e.url === 'string') {
    try {
      return new URL(e.url).host
    } catch {
      return ''
    }
  }
  if (typeof e.query === 'string') return short(e.query, 40)
  if (typeof e.description === 'string') return short(e.description, 40)
  return ''
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

// Roughly four characters to a token: close enough for a waveform.
function count(chunk: unknown): void {
  if (!isLive()) return
  const c = chunk as { kind?: unknown; text?: unknown; json?: unknown }
  if ((c.kind === 'text' || c.kind === 'thinking') && typeof c.text === 'string') tokens += c.text.length / 4
  else if (c.kind === 'input' && typeof c.json === 'string') tokens += c.json.length / 4
}

// Passes every chunk, the return value, and the consumer's return/throw
// straight through to the stream beneath; only peeks to count characters.
function tap<C, R>(stream: AsyncGenerator<C, R>): AsyncGenerator<C, R> {
  const wrapped = {
    async next(...args: [] | [unknown]) {
      const r = await stream.next(...(args as []))
      if (r.done !== true) {
        try {
          count(r.value)
        } catch {
          // Counting never gets in the way of the answer.
        }
      }
      return r
    },
    return: (value: R | PromiseLike<R>) => stream.return(value),
    throw: (error: unknown) => stream.throw(error),
    [Symbol.asyncIterator]() {
      return wrapped
    },
  }
  return wrapped as unknown as AsyncGenerator<C, R>
}

async function refreshMeter($: EngineInterface): Promise<void> {
  if (meterBusy) return
  meterBusy = true
  try {
    const u = await $.session.usage()
    const ctx = u.context
    const pct = ctx.percent ?? (ctx.tokens !== undefined && ctx.window > 0 ? (ctx.tokens / ctx.window) * 100 : null)
    const usd = u.cost?.usd ?? null
    const now = Date.now()
    const hours = Math.max((now - u.startedAt) / 3_600_000, 1 / 60)
    const m: Meter = { ctxPct: pct, usd, burn: usd === null ? null : usd / hours, startedAt: u.startedAt, at: now }
    meterNow = m
    await update($, meter, () => m)
  } catch {
    // A missing reading leaves the last one on screen.
  } finally {
    meterBusy = false
  }
}

// One `git status` with the branch header: it works on an unborn branch, ignores the repo's
// showUntrackedFiles setting, and never runs a repository's aliases or fsmonitor hook.
const GIT_PINS = [
  '-c', 'alias.status=', '-c', 'core.fsmonitor=', '-c', 'status.showUntrackedFiles=normal', '-c', 'status.submoduleSummary=false',
]

export function parseStatus(stdout: string): { branch: string; dirty: number } | null {
  const lines = stdout.split('\n').filter(l => l.trim() !== '')
  const head = lines[0]
  if (head === undefined || !head.startsWith('## ')) return null
  const h = head.slice(3)
  const unborn = h.match(/^(?:No commits yet on|Initial commit on) (\S+)/)
  const branch = unborn !== null ? (unborn[1] as string) : h.startsWith('HEAD (no branch)') ? 'detached' : (h.split('...')[0] ?? h).trim()
  return { branch, dirty: lines.length - 1 }
}

async function refreshGit($: EngineInterface): Promise<void> {
  if (gitBusy) return
  gitBusy = true
  try {
    const cwd = await $.session.cwd()
    const status = await $.process.run(
      ['git', ...GIT_PINS, '--no-optional-locks', 'status', '--porcelain=v1', '-b', '--untracked-files=normal'],
      { cwd, timeoutMs: 2500 },
    )
    const parsed = status.exitCode === 0 ? parseStatus(status.stdout) : null
    if (parsed !== null) {
      await update($, git, (): Git => ({ ...parsed, at: Date.now() }))
    } else if (/not a git repository/i.test(status.stderr)) {
      await update($, git, () => null)
    } else {
      // Busy (an index lock) or broken: keep the branch, never claim "clean".
      await update($, git, (prev): Git | null => (prev === null ? null : { ...prev, dirty: -1, at: Date.now() }))
    }
  } catch {
    await update($, git, (prev): Git | null => (prev === null ? null : { ...prev, dirty: -1, at: Date.now() })).catch(() => undefined)
  } finally {
    gitBusy = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (drawing) return
  drawing = true
  try {
    frame += 1
    const now = Date.now()
    if (now - sampledAt >= SAMPLE_MS) {
      // Tokens per second over the real time since the last sample.
      const seconds = Math.max((now - sampledAt) / 1000, 0.001)
      const rate = sampledAt === 0 ? 0 : tokens / seconds
      tokens = 0
      sampledAt = now
      smoothed = smoothed * 0.55 + rate * 0.45
      samples.push(smoothed)
      if (samples.length > 512) samples.splice(0, samples.length - 512)
      peak = Math.max(20, peak * 0.997, smoothed)
    }
    const m = meterNow
    const elapsed = clockText(m === null ? 0 : now - m.startedAt)
    const header = headerFrame(dims.width, frame, { elapsed, ctxPct: m?.ctxPct ?? null, usd: m?.usd ?? null, rate: smoothed })
    const shown = await $.ui.blit({ requestId: PANE, key: 'header', cells: header.encode() })
    if (shown.deny !== undefined) {
      // No raster mounted: a resize in flight, a narrow or desktop-only pane, or it closed.
      misses += 1
      // Only the animation stops; usage and git keep refreshing while the pane is open.
      if (misses >= 30) stopFrames()
      return
    }
    misses = 0
    await $.ui.blit({ requestId: PANE, key: 'gauge', cells: gaugeFrame(GAUGE_COLS, BAND_ROWS, frame, m?.ctxPct ?? null).encode() })
    await $.ui.blit({ requestId: PANE, key: 'scope', cells: scopeFrame(dims.scopeCols, BAND_ROWS, frame, samples, peak).encode() })
  } catch {
    // A dropped frame is fine; the next one redraws everything.
  } finally {
    drawing = false
  }
}

// Usage and git readings: on while the pane is open, whatever surface draws it.
function startData($: EngineInterface): void {
  if (meterTimer !== null) return
  meterTimer = $.clock.every(METER_MS, () => void refreshMeter($))
  gitTimer = $.clock.every(GIT_MS, () => void refreshGit($))
  void refreshMeter($)
  void refreshGit($)
}

// The 30fps animation: only where a terminal mounts the rasters.
function startFrames($: EngineInterface): void {
  if (frameTimer !== null) return
  misses = 0
  tokens = 0
  sampledAt = 0
  frameTimer = $.clock.every(FRAME_MS, () => void tick($))
}

function startLoop($: EngineInterface): void {
  startData($)
  startFrames($)
}

function stopFrames(): void {
  frameTimer?.cancel()
  frameTimer = null
}

function stopLoop(): void {
  stopFrames()
  meterTimer?.cancel()
  gitTimer?.cancel()
  meterTimer = null
  gitTimer = null
}

async function toggleHud($: EngineInterface): Promise<void> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    stopLoop()
    await $.ui.close({ id: PANE })
    $.ui.toast('NETRUNNER//HUD offline')
    return
  }
  const opened = await $.ui.open({ id: PANE, title: 'NETRUNNER//HUD' })
  startLoop($)
  $.ui.toast(opened.isPlaced ? 'NETRUNNER//HUD online' : `NETRUNNER//HUD waiting for room: ${opened.reason}`)
}

// The task id and outcome a background task's notification carries.
export function parseNotice(text: string): { id: string; status: string | null } | null {
  const id = text.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)
  if (id === null) return null
  const status = text.match(/<status>\s*([a-z_]+)\s*<\/status>/)
  return { id: id[1] as string, status: status === null ? null : (status[1] as string) }
}

// Remove exactly one job by id; a finished background test run updates the TESTS widget.
async function endJob($: EngineInterface, id: string, status: string | null): Promise<void> {
  const list = await read($, jobs)
  const job = list.find(j => j.id === id)
  if (job === undefined) return
  await update($, jobs, cur => cur.filter(j => j.id !== id))
  if (job.test !== undefined && (status === 'completed' || status === 'failed')) {
    const ok = status === 'completed'
    // A failed `cd dir && npm test` may be the cd's failure: the outcome is unclear then.
    const certain = job.test === 'run' || (job.test === 'run-cd' && ok)
    await update($, test, (): TestRun => ({ label: job.label, ok, at: Date.now(), certain }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'NETRUNNER//HUD: open or close the cyberpunk session dashboard',
      immediate: true,
    })
    // A reload drops timers; a pane that stayed up gets its animation back.
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) startLoop($)
    return next(e)
  })

  on('session.end', async (_$, e, next) => {
    stopLoop()
    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    await toggleHud($)
    // A pane-only command: nothing for the transcript, nothing for the model.
    return {}
  })

  on('ui.close', { id: PANE }, async (_$, e, next) => {
    stopLoop()
    return next(e)
  })

  on('turn.step', async function* (_$, e, next) {
    return yield* tap(next(e))
  })

  // A background task's notification ends that job.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      try {
        const notice = parseNotice(e.text)
        if (notice !== null) await endJob($, notice.id, notice.status)
      } catch {
        // The widget can be a little stale; the prompt never waits on it.
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `call-${Date.now()}-${Math.random()}`
    const at = Date.now()
    const call: Call = { id, tool: e.tool, label: labelOf(e as { tool: string }), at, ms: null, isError: false, isSub: e.agentId !== undefined }
    try {
      await update($, calls, list => [...list, call].slice(-MAX_CALLS))
    } catch {
      // Bookkeeping never gets in the way of the tool.
    }

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (err) {
      // The tool (or a hook beneath) threw: finish the row as an error, then let the error go on.
      await update($, calls, list => list.map(c => (c.id === id ? { ...c, ms: Date.now() - at, isError: true } : c))).catch(() => undefined)
      throw err
    }

    try {
      const ms = Date.now() - at
      const isError = ran.deny !== undefined || ran.isError === true
      await update($, calls, list => list.map(c => (c.id === id ? { ...c, ms, isError } : c)))
      if (e.tool === 'Bash' && ran.deny === undefined) {
        const command = String(e.command ?? '')
        const result = ran.result as { backgroundTaskId?: string } | undefined
        if (result?.backgroundTaskId !== undefined) {
          const kind = testOutcome(command)
          const job: Job = { id: result.backgroundTaskId, label: short(command, 40), at, ...(kind === null ? {} : { test: kind }) }
          await update($, jobs, list => [...list.filter(j => j.id !== job.id), job].slice(-16))
        } else {
          const outcome = testOutcome(command)
          if (outcome !== null) {
            const ok = ran.isError !== true
            // After leading `cd` steps, a failure may be the cd's: only a pass is certain then.
            const certain = outcome === 'run' || (outcome === 'run-cd' && ok)
            const t: TestRun = { label: short(command, 32), ok, at: Date.now(), certain }
            await update($, test, () => t)
          }
        }
        if (dataOn() && /(^|[\s;&|(])git\s/.test(command)) void refreshGit($)
      }
      const stop = e as { task_id?: unknown; shell_id?: unknown }
      const stopped = typeof stop.task_id === 'string' ? stop.task_id : stop.shell_id
      if (e.tool === 'TaskStop' && typeof stopped === 'string' && !isError) await endJob($, stopped, null)
    } catch {
      // As above.
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, calls)
    const bg = await read($, jobs)
    const g = await read($, git)
    const t = await read($, test)
    const m = (await read($, meter)) ?? meterNow
    const now = Date.now()
    const ctxText = m?.ctxPct == null ? '--' : `${Math.round(m.ctxPct)}%`
    const costText = m?.usd == null ? '--' : `$${m.usd.toFixed(2)}`
    const gitText = g === null ? '--' : `${g.branch} (${g.dirty < 0 ? '?' : g.dirty} dirty)`
    const testText = t === null ? '--' : !t.certain ? 'ran (outcome unclear)' : t.ok ? 'pass' : 'FAIL'
    const columns = e.props.bodyColumns

    // Desktop and very narrow panes get a compact text view: no animation there, but the
    // usage and git readings keep refreshing.
    if (e.surface !== 'terminal' || columns < MIN_RASTER_WIDTH) {
      startData($)
      const { Box, Text } = $.ui.resolve(e)
      const last = list.slice(-8).reverse()
      return (
        <Box flexDirection="column">
          <Text bold color="#ff2bd6">NETRUNNER//HUD</Text>
          <Text wrap="wrap">
            CTX {ctxText} · cost {costText} · git {gitText} · tests {testText} · jobs {bg.length}
          </Text>
          {last.map(c => (
            <Text key={c.id} wrap="truncate" color={c.isError ? '#ff3355' : toolColor(c.tool)}>
              {c.tool} {c.ms === null ? '…' : `${(c.ms / 1000).toFixed(1)}s`} {c.label}
            </Text>
          ))}
        </Box>
      )
    }

    // A terminal is drawing the rasters: make sure they animate.
    startLoop($)

    const { Box, Text, Raster } = $.ui.resolve(e)
    const width = Math.min(200, columns)
    const scopeCols = Math.max(16, width - GAUGE_COLS - 1)
    dims.width = width
    dims.scopeCols = scopeCols
    // A docked pane is as tall as its body; inline, use the viewport.
    const bodyRows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : (e.viewport?.rows ?? 40)
    const waterfallRows = Math.max(2, Math.min(20, bodyRows - 1 - BAND_ROWS - 1 - 5))
    const elapsed = clockText(m === null ? 0 : now - m.startedAt)
    const widgetWidth = Math.floor(width / 4)
    const barWidth = Math.max(6, Math.min(24, width - 60))
    const recent = list.slice(-waterfallRows).reverse()

    return (
      <Box flexDirection="column" width={width}>
        <Raster key="header" columns={width} rows={1} cells={headerFrame(width, frame, { elapsed, ctxPct: m?.ctxPct ?? null, usd: m?.usd ?? null, rate: smoothed }).encode()} />
        <Box flexDirection="row">
          <Raster key="gauge" columns={GAUGE_COLS} rows={BAND_ROWS} cells={gaugeFrame(GAUGE_COLS, BAND_ROWS, frame, m?.ctxPct ?? null).encode()} />
          <Text> </Text>
          <Raster key="scope" columns={scopeCols} rows={BAND_ROWS} cells={scopeFrame(scopeCols, BAND_ROWS, frame, samples, peak).encode()} />
        </Box>
        <Text color="#ff2bd6" bold>
          {`░▒▓ TOOL WATERFALL ${'─'.repeat(Math.max(0, width - 20))}`.slice(0, width)}
        </Text>
        {recent.length === 0 && <Text color="#2a3550">  awaiting first jack-in… run a prompt</Text>}
        {recent.map(c => (
          <Box key={c.id} flexDirection="row">
            <Text color="#2a3550">{`+${clockText(m === null ? 0 : c.at - m.startedAt)} `}</Text>
            <Text color={toolColor(c.tool)} bold>{`${c.isSub ? '↳' : ' '}${c.tool.slice(0, 11).padEnd(11)} `}</Text>
            <Text color={c.isError ? '#ff3355' : toolColor(c.tool)}>{bar(c.ms, barWidth).padEnd(barWidth)}</Text>
            <Text color={c.isError ? '#ff3355' : '#c8f7ff'}>{` ${c.ms === null ? ' live' : `${(c.ms / 1000).toFixed(1).padStart(4)}s`}${c.isError ? ' ERR' : '    '} `}</Text>
            <Text color="#5b6b8c" wrap="truncate">{c.label}</Text>
          </Box>
        ))}
        <Box flexDirection="row">
          <Box flexDirection="column" borderStyle="round" borderColor="#9d4dff" width={widgetWidth} paddingLeft={1}>
            <Text color="#9d4dff" bold>{`BG JOBS ${bg.length}`}</Text>
            {bg.length === 0 && <Text color="#2a3550">none running</Text>}
            {bg.slice(-2).map(j => (
              <Text key={j.id} wrap="truncate" color="#c8f7ff">{`${ago(now - j.at)} ${j.label}`}</Text>
            ))}
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="#00f0ff" width={widgetWidth} paddingLeft={1}>
            <Text color="#00f0ff" bold>GIT</Text>
            <Text wrap="truncate" color="#c8f7ff">{g === null ? 'no repo' : g.branch}</Text>
            <Text color={g === null || g.dirty < 0 ? '#5b6b8c' : g.dirty > 0 ? '#ffb000' : '#39ff14'}>
              {g === null ? '' : g.dirty < 0 ? 'status unknown' : g.dirty > 0 ? `${g.dirty} dirty` : 'clean'}
            </Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor={t === null || !t.certain ? '#2a3550' : t.ok ? '#39ff14' : '#ff3355'} width={widgetWidth} paddingLeft={1}>
            <Text color={t === null || !t.certain ? '#5b6b8c' : t.ok ? '#39ff14' : '#ff3355'} bold>
              {t === null ? 'TESTS --' : !t.certain ? 'TESTS ?' : t.ok ? 'TESTS ✓ PASS' : 'TESTS ✗ FAIL'}
            </Text>
            <Text wrap="truncate" color="#c8f7ff">{t === null ? 'no run yet' : t.label}</Text>
            <Text color="#5b6b8c">{t === null ? '' : `${ago(now - t.at)} ago`}</Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="#ffb000" width={width - widgetWidth * 3} paddingLeft={1}>
            <Text color="#ffb000" bold>COST</Text>
            <Text color="#c8f7ff">{costText}</Text>
            <Text color="#5b6b8c">{m?.burn == null ? '' : `$${m.burn.toFixed(2)}/h burn`}</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
