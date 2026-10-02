// Pure drawing for the HUD: a cell grid, a braille canvas on top of it, and the
// frame builders the animation loop blits. Nothing here touches the engine.

export const BG = 0x07070d
export const DEFAULT = 0x01000000
export const NEON = {
  cyan: 0x00f0ff,
  magenta: 0xff2bd6,
  green: 0x39ff14,
  amber: 0xffb000,
  red: 0xff3355,
  violet: 0x9d4dff,
  dim: 0x2a3550,
  grid: 0x141c2c,
  text: 0xc8f7ff,
}

// Half-width katakana: printable, width 1, in the BMP. Used for glitch flicker.
const GLITCH = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ'

/** A grid of [codePoint, fg, bg] cells, the layout a Raster takes. */
export class Grid {
  readonly cells: Uint32Array
  constructor(readonly columns: number, readonly rows: number, bg = BG) {
    this.cells = new Uint32Array(columns * rows * 3)
    for (let i = 0; i < columns * rows; i += 1) {
      this.cells[i * 3] = 0x20
      this.cells[i * 3 + 1] = NEON.text
      this.cells[i * 3 + 2] = bg
    }
  }

  put(x: number, y: number, ch: number, fg: number, bg?: number): void {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return
    const i = (y * this.columns + x) * 3
    this.cells[i] = ch
    this.cells[i + 1] = fg
    if (bg !== undefined) this.cells[i + 2] = bg
  }

  text(x: number, y: number, s: string, fg: number | ((i: number) => number), bg?: number): void {
    let i = 0
    for (const c of s) {
      const cp = c.codePointAt(0) ?? 0x20
      // Only width-1 BMP characters are allowed in a Raster.
      const safe = cp >= 0x20 && cp <= 0xffff ? cp : 0x3f
      this.put(x + i, y, safe, typeof fg === 'number' ? fg : fg(i), bg)
      i += 1
    }
  }

  tintRow(y: number, bg: number): void {
    if (y < 0 || y >= this.rows) return
    for (let x = 0; x < this.columns; x += 1) this.cells[(y * this.columns + x) * 3 + 2] = bg
  }

  encode(): string {
    return base64(new Uint8Array(this.cells.buffer))
  }
}

// Braille dot bits for (x in 0..1, y in 0..3) inside one cell.
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

/** A 2x4-subpixel braille canvas drawn into a Grid region. */
export class Braille {
  readonly bits: Uint8Array
  readonly color: Uint32Array
  readonly width: number
  readonly height: number
  constructor(readonly columns: number, readonly rows: number) {
    this.width = columns * 2
    this.height = rows * 4
    this.bits = new Uint8Array(columns * rows)
    this.color = new Uint32Array(columns * rows)
  }

  dot(x: number, y: number, color: number): void {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    const cx = px >> 1
    const cy = py >> 2
    const i = cy * this.columns + cx
    this.bits[i] = (this.bits[i] ?? 0) | (DOT[py & 3]?.[px & 1] ?? 0)
    // The brightest colour drawn into a cell wins.
    if (luma(color) >= luma(this.color[i] ?? 0)) this.color[i] = color
  }

  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps
      this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color)
    }
  }

  blitInto(grid: Grid, ox: number, oy: number, bg = BG): void {
    for (let cy = 0; cy < this.rows; cy += 1) {
      for (let cx = 0; cx < this.columns; cx += 1) {
        const i = cy * this.columns + cx
        const b = this.bits[i] ?? 0
        if (b === 0) continue
        grid.put(ox + cx, oy + cy, 0x2800 + b, this.color[i] ?? NEON.text, bg)
      }
    }
  }
}

export function luma(c: number): number {
  return ((c >> 16) & 0xff) * 0.3 + ((c >> 8) & 0xff) * 0.59 + (c & 0xff) * 0.11
}

export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * (1 - k) + ((b >> s) & 0xff) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export function scale(c: number, k: number): number {
  return mix(BG, c, k)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64; a Raster's `cells` format. */
export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

/** A small seeded PRNG so glitches are deterministic per frame. */
export function rand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ---------------------------------------------------------------- frames

export type HeaderData = { elapsed: string; ctxPct: number | null; usd: number | null; rate: number }

/** One row: the title with a magenta→cyan sweep, a moving scanline and rare glitches. */
export function headerFrame(columns: number, frame: number, d: HeaderData): Grid {
  const g = new Grid(columns, 1, 0x0b0b18)
  const ctx = d.ctxPct === null ? '--' : `${Math.round(d.ctxPct)}%`
  const usd = d.usd === null ? '--' : `$${d.usd.toFixed(2)}`
  const title = ' ▓▒░ NETRUNNER//HUD ░▒▓ '
  // Drop trailing readouts until the line fits beside the title, so nothing is ever cut mid-field.
  const fields = [`UPLINK ${d.elapsed}`, `CTX ${ctx}`, usd, `${Math.round(d.rate)} tok/s`]
  let right = ''
  for (let n = fields.length; n >= 0; n -= 1) {
    right = n === 0 ? '' : ` ${fields.slice(0, n).join('  ')} `
    if (title.length + right.length <= columns) break
  }
  const sweep = (frame % 90) / 90
  g.text(0, 0, title, i => mix(NEON.magenta, NEON.cyan, (i / title.length + sweep) % 1))
  g.text(Math.max(title.length, columns - right.length), 0, right, NEON.text)
  // Scanline: a bright band that crosses the header.
  const band = Math.floor((frame * 1.5) % (columns + 12)) - 6
  for (let x = band; x < band + 6; x += 1) {
    if (x < 0 || x >= columns) continue
    g.cells[x * 3 + 2] = mix(0x0b0b18, NEON.cyan, 0.25 - Math.abs(x - band - 3) * 0.06)
  }
  // Glitch: every ~3s, a couple of title cells flicker to katakana for 2 frames.
  if (frame % 90 < 2) {
    for (let k = 0; k < 3; k += 1) {
      const x = Math.floor(rand(frame * 7 + k) * title.length)
      const c = GLITCH[Math.floor(rand(frame * 13 + k) * GLITCH.length)] ?? 'ｱ'
      g.put(x, 0, c.codePointAt(0) ?? 0x20, NEON.green)
    }
  }
  return g
}

/** A semicircular braille gauge for context fill, with a pulsing tip. */
export function gaugeFrame(columns: number, rows: number, frame: number, pct: number | null): Grid {
  const g = new Grid(columns, rows)
  const c = new Braille(columns, rows - 1)
  const cx = c.width / 2
  const cy = c.height - 2
  const r1 = Math.min(cx - 2, cy - 1)
  const r0 = Math.max(2, r1 - 4)
  const p = pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100
  const steps = 96
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps
    const a = Math.PI * (1 - t)
    const lit = t <= p
    const col = lit ? (t < 0.6 ? mix(NEON.green, NEON.amber, t / 0.6) : mix(NEON.amber, NEON.red, (t - 0.6) / 0.4)) : NEON.dim
    for (let r = r0; r <= r1; r += 1) c.dot(cx + Math.cos(a) * r, cy - Math.sin(a) * r * 0.95, col)
  }
  // Tick marks every 10%.
  for (let k = 0; k <= 10; k += 1) {
    const a = Math.PI * (1 - k / 10)
    c.line(cx + Math.cos(a) * (r1 + 1), cy - Math.sin(a) * (r1 + 1) * 0.95, cx + Math.cos(a) * (r1 + 2), cy - Math.sin(a) * (r1 + 2) * 0.95, NEON.grid)
  }
  // Needle with a breathing glow.
  const a = Math.PI * (1 - p)
  const glow = 0.6 + 0.4 * Math.sin(frame / 6)
  c.line(cx, cy, cx + Math.cos(a) * (r0 - 1), cy - Math.sin(a) * (r0 - 1) * 0.95, scale(NEON.cyan, glow))
  c.blitInto(g, 0, 0)
  const label = pct === null ? 'CTX --' : `CTX ${Math.round(pct)}%`
  g.text(Math.max(0, Math.floor((columns - label.length) / 2)), rows - 1, label, p > 0.8 ? NEON.red : NEON.cyan)
  return g
}

/** A scrolling braille oscilloscope with phosphor fade and a faint grid. */
export function scopeFrame(columns: number, rows: number, frame: number, samples: readonly number[], peak: number): Grid {
  const g = new Grid(columns, rows)
  const c = new Braille(columns, rows - 1)
  const w = c.width
  const h = c.height
  for (let x = 0; x < w; x += 8) for (let y = 0; y < h; y += 4) c.dot(x, y, NEON.grid)
  const max = Math.max(peak, 1)
  const n = Math.min(samples.length, w)
  let prev: [number, number] | null = null
  for (let i = 0; i < n; i += 1) {
    const v = samples[samples.length - n + i] ?? 0
    // An idle hum keeps the trace alive without inventing load.
    const hum = Math.sin((frame + i) / 5) * 0.6
    const x = w - n + i
    const y = h - 2 - (Math.min(v, max) / max) * (h - 4) + hum
    const age = (n - 1 - i) / Math.max(1, n - 1)
    const col = mix(NEON.green, NEON.dim, age * 0.85)
    if (prev !== null) c.line(prev[0], prev[1], x, y, col)
    else c.dot(x, y, col)
    prev = [x, y]
  }
  c.blitInto(g, 0, 0)
  const last = samples[samples.length - 1] ?? 0
  g.text(1, rows - 1, `TOKEN FLUX ${String(Math.round(last)).padStart(4)} tok/s  peak ${Math.round(max)}`, NEON.green)
  return g
}

export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export const TOOL_COLOR: Record<string, string> = {
  Bash: '#39ff14',
  Edit: '#ffb000',
  Write: '#ffb000',
  NotebookEdit: '#ffb000',
  Read: '#00f0ff',
  Grep: '#00f0ff',
  Glob: '#00f0ff',
  WebFetch: '#9d4dff',
  WebSearch: '#9d4dff',
  Agent: '#ff2bd6',
}

export function toolColor(tool: string): string {
  if (tool.startsWith('mcp__')) return '#9d4dff'
  return TOOL_COLOR[tool] ?? '#c8f7ff'
}

/** A duration bar on a log scale: 100ms is a sliver, a minute fills the width. */
export function bar(ms: number | null, width: number): string {
  if (ms === null) return '▒'.repeat(Math.max(1, Math.min(3, width)))
  const t = Math.max(0, Math.min(1, Math.log10(Math.max(ms, 50) / 50) / Math.log10(60000 / 50)))
  const eighths = Math.round(t * width * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  return '█'.repeat(full) + (part > 0 ? ' ▏▎▍▌▋▊▉'[part] ?? '' : '') || '▏'
}

// What counts as running a test suite: the runner must be the program a
// segment executes, not a word that appears in a branch name or a file path,
// and it must actually execute tests (not list, install, compile or print help).
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'exec'])
const PMS = ['npm', 'yarn', 'pnpm', 'bun']
// Package-manager flags before the script name that take an operand.
const PM_VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '--workspace', '-w'])
// Modes that run no tests.
const NOT_A_RUN = new Set([
  '--version', '-V', '--help', '-h', '--listTests', '--showConfig', '--collect-only', '--co', '--no-run',
  '--list-tests', '--list', '-DskipTests', '-Dmaven.test.skip=true', '--dry-run',
])
const RUNNERS: ((w: string[]) => boolean)[] = [
  w => PMS.includes(w[0] ?? '') && (w[1] === 'test' || w[1] === 't' || (w[1] === 'run' && /^test(:|$)/.test(w[2] ?? '')) || /^test:/.test(w[1] ?? '')),
  w => ['npx', 'bunx', 'pnpx'].includes(w[0] ?? '') && isDirect(stripFlags(w.slice(1))),
  w => (w[0] === 'pnpm' || w[0] === 'yarn') && (w[1] === 'exec' || w[1] === 'dlx') && isDirect(w.slice(2)),
  w => isDirect(w),
  w => (w[0] === 'python' || w[0] === 'python3') && w[1] === '-m' && (w[2] === 'pytest' || w[2] === 'unittest'),
  w => base(w[0]) === 'node' && w.includes('--test'),
  w => w[0] === 'go' && w[1] === 'test' && !w.includes('-c') && !w.some(a => a === '-list' || a.startsWith('-list=')),
  w => w[0] === 'cargo' && (w[1] === 'test' || (w[1] === 'nextest' && w[2] === 'run')),
  w => ['swift', 'flutter', 'dart', 'mix', 'dotnet'].includes(w[0] ?? '') && w[1] === 'test',
  w => w[0] === 'mvn' && w.slice(1).some(a => a === 'test' || a === 'verify' || /:test$/.test(a)),
  w => (base(w[0]) === 'gradlew' || w[0] === 'gradle') && w.slice(1).some(a => /^(:[\w-]+)*:?(test\w*|check)$/.test(a) && !/Classes$/.test(a)),
  w => w[0] === 'xcodebuild' && w.slice(1).some(a => a === 'test' || a === 'test-without-building'),
  w => w[0] === 'make' && w.slice(1).some(a => a === 'test' || a === 'check'),
]

// A test runner invoked directly: jest, vitest (not `vitest list`), mocha, pytest, rspec, phpunit, ava,
// and playwright only as `playwright test`.
function isDirect(w: string[]): boolean {
  const prog = base(w[0])
  if (prog === 'playwright') return w[1] === 'test'
  if (prog === 'vitest' && w[1] === 'list') return false
  return ['jest', 'vitest', 'mocha', 'pytest', 'rspec', 'phpunit', 'ava'].includes(prog)
}

function base(p: string | undefined): string {
  return (p ?? '').split('/').pop() ?? ''
}

function stripFlags(w: string[]): string[] {
  return w.filter(a => !a.startsWith('-'))
}

function words(segment: string): string[] {
  const w = segment.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < w.length && (WRAPPERS.has(w[i] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] ?? ''))) i += 1
  const out = w.slice(i)
  // `npm --prefix app test`: package-manager flags before the script name.
  if (PMS.includes(out[0] ?? '')) {
    let j = 1
    while (j < out.length && (out[j] ?? '').startsWith('-')) j += PM_VALUE_FLAGS.has(out[j] ?? '') ? 2 : 1
    return [out[0] as string, ...out.slice(j)]
  }
  return out
}

const isRunner = (seg: string) => {
  const w = words(seg)
  return !w.some(a => NOT_A_RUN.has(a)) && w[1] !== 'install' && RUNNERS.some(r => r(w))
}

/**
 * 'run' when the whole command is one test invocation, so the call's exit
 * status is the suite's; 'run-cd' when it is that after leading `cd dir &&`
 * steps (a failure may be the cd's, not the suite's); 'unknown' when a test
 * runner is only part of a compound command; null when no test ran.
 */
export function testOutcome(command: string): 'run' | 'run-cd' | 'unknown' | null {
  // `bash -c '…'` / `sh -lc "…"` as the whole command: judge what it runs.
  const wrapped = command.trim().match(/^(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/)
  if (wrapped !== null) return testOutcome(wrapped[2] as string)
  // A heredoc body is data. Anything after the heredoc's terminator is more commands we can't place.
  let code = command
  const doc = command.match(/<<-?\s*(['"]?)(\w+)\1/)
  if (doc !== null) {
    const lines = command.slice((doc.index ?? 0) + doc[0].length).split('\n')
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === doc[2])
    if (end < 0 || lines.slice(end + 1).some(l => l.trim() !== '')) {
      return isRunner(command.slice(0, doc.index ?? 0)) ? 'unknown' : null
    }
    code = command.slice(0, doc.index ?? 0)
  }
  // Redirections (`2>&1`, `&>file`) are not command separators.
  const unquoted = code.replace(/'[^']*'|"[^"]*"/g, '""').replace(/\d*>&\d*|&>>?|\d*>>?/g, ' ')
  const parts = unquoted.split(/\n|&&|\|\||;|\||&/).map(s => s.trim()).filter(Boolean)
  const hits = parts.filter(isRunner)
  if (hits.length === 0) return null
  const onlyAnd = !/\|\||;|\||&|\n/.test(unquoted.replace(/&&/g, ''))
  // Only `cd dir &&` steps before the runner, and nothing at all after it.
  let lead = 0
  while (lead < parts.length && /^cd(\s|$)/.test(parts[lead] ?? '')) lead += 1
  const exact = hits.length === 1 && onlyAnd && parts.length === lead + 1 && isRunner(parts[lead] ?? '')
  if (!exact) return 'unknown'
  return lead > 0 ? 'run-cd' : 'run'
}
