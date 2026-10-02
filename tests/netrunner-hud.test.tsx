import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { base64, gaugeFrame, Grid, headerFrame, scopeFrame, testOutcome } from '../hooks/gfx'
import { parseNotice, parseStatus } from '../hooks/register'

const PANE = 'netrunner-hud'
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (text: string) => ({ isError: true as const, result: text, text })

type World = { blits: string[]; panes: { id: string }[]; opened: number; toasts: string[]; statusFails: boolean; gitClean: boolean; usd: number; clock: ReturnType<typeof mock.clock> }

function world(on: On): World {
  const w: World = { blits: [], panes: [], opened: 0, toasts: [], statusFails: false, gitClean: false, usd: 0.42, clock: mock.clock(on, { now: 1_000_000 }) }
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: Date.now() - 65_000, context: { tokens: 74_000, window: 200_000, percent: 37 }, rateLimits: [], cost: { usd: w.usd } } }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', (_$, e) => {
    // Drop the pinned -c overrides so the cases read plainly.
    const argv = e.argv.filter((a, i, all) => a !== '-c' && all[i - 1] !== '-c' && a !== '--no-optional-locks')
    const cmd = argv.join(' ')
    if (cmd === 'git status --porcelain=v1 -b --untracked-files=normal') {
      if (w.statusFails) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: Unable to create index.lock', isStdoutTruncated: false, isStderrTruncated: false } }
      return ok(w.gitClean ? '## feature/hud...origin/feature/hud\n' : '## feature/hud...origin/feature/hud\n M a.ts\n?? b.ts\n')
    }
    return ok('')
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: w.panes as never }))
  on('ui.open', (_$, e) => {
    w.opened += 1
    w.panes.push({ id: e.id })
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    w.panes = w.panes.filter(p => p.id !== e.id)
    return { value: undefined } as never
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined } as never
  })
  on('ui.blit', (_$, e) => {
    w.blits.push(e.key)
    return { value: {} }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
  return w
}

const hud = { command: 'hud', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const PANE_PROPS = {
  title: 'NETRUNNER//HUD',
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const mountPane = (surface: 'terminal' | 'desktop') =>
  ({ plugin: 'netrunner-hud', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS }) as never

test('/hud opens the pane and animates three rasters until it closes', async ($, on) => {
  const w = world(on)
  const out = await $.command.run(hud)
  // A pane-only command puts nothing in the transcript.
  expect(out.text).toBeUndefined()
  expect(w.toasts.join(' ')).toMatch(/online/)
  expect(w.opened).toBe(1)
  await w.clock.advance(200)
  expect(w.blits).toContain('header')
  expect(w.blits).toContain('gauge')
  expect(w.blits).toContain('scope')

  // Running /hud again closes it, and the animation stops with it.
  await $.command.run(hud)
  expect(w.panes.length).toBe(0)
  const before = w.blits.length
  await w.clock.advance(500)
  expect(w.blits.length).toBe(before)
})

test('the waterfall shows real calls, failures and the test widget', async ($, on) => {
  world(on)
  let red = true
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command === 'npm test') return red ? fail('1 failing') : { result: { stdout: '' }, text: '3 passing' }
    return { result: { stdout: '' }, text: 'ok' }
  })
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/cart.ts' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Raster', key: 'header' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'scope' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cart\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /TESTS ✗ FAIL/ })).toBeDefined()
  await ui.unmount()

  red = false
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const again = await $.ui.mount(mountPane('terminal'))
  expect(await again.find({ type: 'Text', text: /TESTS ✓ PASS/ })).toBeDefined()
  await again.unmount()
})

test('background jobs and git state show in their widgets', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { backgroundTaskId: 'bg-1' }, text: 'started' }))
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.command.run(hud)
  await w.clock.advance(150)
  const ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Text', text: /BG JOBS 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm run dev/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /feature\/hud/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 dirty/ })).toBeDefined()
  await ui.unmount()
})

test('desktop gets a text summary instead of rasters', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: '' }, text: 'ok' }))
  await $.tool.call({ tool: 'WebSearch', query: 'kitty graphics protocol' , mode: 'standard' })
  const ui = await $.ui.mount(mountPane('desktop'))
  expect(await ui.find({ type: 'Text', text: /NETRUNNER\/\/HUD/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /WebSearch/ })).toBeDefined()
  await ui.unmount()
})

test('tool results pass through untouched', async ($, on) => {
  world(on)
  on('tool.call', () => fail('boom'))
  const ran = await $.tool.call({ tool: 'Bash', command: 'false' })
  expect(ran.isError).toBe(true)
  expect(ran.text).toBe('boom')
})

test('frames encode to exactly columns x rows cells of width-1 characters', () => {
  for (const g of [headerFrame(80, 7, { elapsed: '00:01:05', ctxPct: 37, usd: 0.42, rate: 120 }), gaugeFrame(24, 9, 3, 91), scopeFrame(60, 9, 5, [0, 10, 50, 200, 80], 200)]) {
    const words = g.cells
    expect(words.length).toBe(g.columns * g.rows * 3)
    for (let i = 0; i < words.length; i += 3) {
      const cp = words[i] ?? 0
      expect(cp >= 0x20 && cp <= 0xffff).toBe(true)
    }
    expect(g.encode().length).toBe(Math.ceil((g.columns * g.rows * 12) / 3) * 4)
  }
  // Known vector: "Man" encodes to "TWFu", padding handled.
  expect(base64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
  expect(base64(new Uint8Array([77, 97]))).toBe('TWE=')
  expect(base64(new Uint8Array([77]))).toBe('TQ==')
  expect(new Grid(2, 1).encode().length).toBe(32)
})

test('turn.step passes every chunk and the final result through untouched', async ($, on) => {
  const chunks = [
    { kind: 'text', index: 0, text: 'hello world' },
    { kind: 'thinking', index: 1, text: 'weighing options' },
    { kind: 'input', index: 2, json: '{"command":"ls"}' },
  ]
  on('turn.step', async function* (_$, _e, _next) {
    for (const c of chunks) yield c as never
    return { turnId: 't', index: 0, answer: 'done', toolUses: [] } as never
  })
  const seen: unknown[] = []
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)
  let last: IteratorResult<unknown, unknown>
  while (!(last = await stream.next()).done) seen.push(last.value)
  expect(seen).toEqual(chunks)
  expect((last.value as { answer?: string } | undefined)?.answer).toBe('done')
})

test('closing the consumer early closes the stream beneath', async ($, on) => {
  let closed = false
  on('turn.step', async function* (_$, _e, _next) {
    try {
      yield { kind: 'text', index: 0, text: 'a' } as never
      yield { kind: 'text', index: 1, text: 'b' } as never
    } finally {
      closed = true
    }
    return { turnId: 't', index: 0, answer: '', toolUses: [] } as never
  })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)
  for await (const _c of stream) break
  expect(closed).toBe(true)
})

test('test detection ignores names in branches and paths and flags compound runs', () => {
  expect(testOutcome('npm test')).toBe('run')
  expect(testOutcome('cd app && pnpm exec vitest run')).toBe('run-cd')
  expect(testOutcome('npx jest src/cart.test.ts')).toBe('run')
  expect(testOutcome('./gradlew :app:test')).toBe('run')
  expect(testOutcome('flutter test')).toBe('run')
  expect(testOutcome('git checkout -b jest-fix')).toBeNull()
  expect(testOutcome('rg jest src')).toBeNull()
  expect(testOutcome('cat jest.config.ts')).toBeNull()
  expect(testOutcome('echo npm test')).toBeNull()
  expect(testOutcome('jest --version')).toBeNull()
  expect(testOutcome('npm test || true')).toBe('unknown')
  expect(testOutcome('npm test | tail -5')).toBe('unknown')
})

test('only commands that execute tests count, and only leading cd steps are allowed', () => {
  for (const cmd of [
    'npx playwright install', 'npx playwright --version', 'pnpm exec vitest --version', 'jest --listTests', 'jest --showConfig',
    'vitest list', 'pytest --collect-only', 'pytest -h', 'python -m pytest --version', 'cargo test --no-run', 'cargo nextest list',
    'go test -list=Test ./...', 'dotnet test --list-tests', 'mvn -DskipTests test', './gradlew testClasses',
  ]) expect(testOutcome(cmd)).toBeNull()
  expect(testOutcome('npx playwright test')).toBe('run')
  expect(testOutcome('cargo nextest run')).toBe('run')
  expect(testOutcome('npm test 2>&1')).toBe('run')
  expect(testOutcome('npm --prefix packages/app test')).toBe('run')
  expect(testOutcome("bash -lc 'npm test'")).toBe('run')
  expect(testOutcome('node --test')).toBe('run')
  expect(testOutcome('./gradlew :app:testDebugUnitTest')).toBe('run')
  expect(testOutcome('cd /nope && npm test')).toBe('run-cd')
  expect(testOutcome('npm test && cd /missing')).toBe('unknown')
  expect(testOutcome('npm test <<EOF\ninput\nEOF\nfalse')).toBe('unknown')
  expect(testOutcome('npm test <<EOF\ninput\nEOF')).toBe('run')
})

test('git status parsing: unborn branches, detached heads and counts', () => {
  expect(parseStatus('## No commits yet on main\n?? a.ts\n')).toEqual({ branch: 'main', dirty: 1 })
  expect(parseStatus('## main...origin/main [ahead 1]\n')).toEqual({ branch: 'main', dirty: 0 })
  expect(parseStatus('## HEAD (no branch)\n M x\n')).toEqual({ branch: 'detached', dirty: 1 })
  expect(parseStatus('')).toBeNull()
})

test('task ids match exactly', () => {
  expect(parseNotice('<task-notification><task-id>bg-42</task-id><status>failed</status></task-notification>')).toEqual({ id: 'bg-42', status: 'failed' })
})

test('a finished background task leaves the jobs widget', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { backgroundTaskId: 'bg-42' }, text: 'started' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.command.run(hud)
  await w.clock.advance(100)
  let ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Text', text: /BG JOBS 1/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: '<task-notification><task-id>bg-42</task-id><status>completed</status></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Text', text: /BG JOBS 0/ })).toBeDefined()
  await ui.unmount()
})

test('a failing git status after a clean one reads as unknown, never as clean', async ($, on) => {
  const w = world(on)
  w.gitClean = true
  await $.command.run(hud)
  await w.clock.advance(100)
  w.statusFails = true
  await w.clock.advance(5_100)
  const ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Text', text: /status unknown/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^clean$/ })).toBeUndefined()
  await ui.unmount()
})

test('a narrow pane gets the compact text view', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'netrunner-hud', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 40 } } as never)
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /NETRUNNER\/\/HUD/ })).toBeDefined()
  await ui.unmount()
})

test('a finished job removes only that job, and a background test run updates the TESTS widget', async ($, on) => {
  const w = world(on)
  let n = 0
  on('tool.call', () => {
    n += 1
    return { result: { backgroundTaskId: n === 1 ? 'bg-4' : 'bg-42' }, text: 'started' }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true })
  await $.command.run(hud)
  await w.clock.advance(100)
  await $.prompt.submit({ text: '<task-notification><task-id>bg-42</task-id><status>failed</status></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  const ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Text', text: /BG JOBS 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /TESTS ✗ FAIL/ })).toBeDefined()
  await ui.unmount()
})

test('TaskStop removes the job it names', async ($, on) => {
  const w = world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? { result: { backgroundTaskId: 'bg-7' }, text: 'started' } : { result: { message: 'stopped' }, text: 'stopped' }))
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.tool.call({ tool: 'TaskStop', task_id: 'bg-7' } as never)
  await $.command.run(hud)
  await w.clock.advance(100)
  const ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Text', text: /BG JOBS 0/ })).toBeDefined()
  await ui.unmount()
})

test('a tool call that throws is finished as an error, not left live', async ($, on) => {
  const w = world(on)
  on('tool.call', () => {
    throw new Error('boom')
  })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' }).catch(() => undefined)
  await $.command.run(hud)
  await w.clock.advance(100)
  const ui = await $.ui.mount(mountPane('terminal'))
  expect(await ui.find({ type: 'Text', text: / live/ })).toBeUndefined()
  await ui.unmount()
})

test('the compact view keeps refreshing usage after the animation stops', async ($, on) => {
  const w = world(on)
  await $.command.run(hud)
  const narrow = { plugin: 'netrunner-hud', surface: 'desktop', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 100 } }
  const ui = await $.ui.mount(narrow as never)
  await w.clock.advance(2_000)
  w.usd = 9.99
  await w.clock.advance(2_000)
  await ui.unmount()
  const again = await $.ui.mount(narrow as never)
  expect(await again.find({ type: 'Text', text: /\$9\.99/ })).toBeDefined()
  await again.unmount()
})

test('the header never cuts a readout at narrow raster widths', () => {
  const row = headerFrame(60, 1, { elapsed: '00:00:00', ctxPct: 50, usd: 1.23, rate: 999 })
  const text = String.fromCodePoint(...Array.from({ length: 60 }, (_v, i) => row.cells[i * 3] ?? 32))
  expect(text).not.toMatch(/tok\/$|to$/)
})
