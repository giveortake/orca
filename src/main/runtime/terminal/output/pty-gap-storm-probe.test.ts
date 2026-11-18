// TEMPORARY measurement probe (not for merge): main-side cost of a hidden-agent storm with daemon keep-tail gaps.
import { it } from 'vitest'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
// @ts-expect-error -- benchmark helper is plain ESM JS
import { buildFixture } from '../../../../../tests/tools/benchmarks/terminal-pipeline-bench.mjs'

const PTYS = Number(process.env.STORM_PTYS ?? 150)
const BYTES_PER_PTY = Number(process.env.STORM_BYTES ?? 1024 * 1024)
const GAP_EVERY_CHUNKS = Number(process.env.STORM_GAP_EVERY ?? 32)
const DROPPED_CHARS = 256 * 1024
const CHUNK = 4096
const grid = { cols: 120, rows: 40 }

async function screenSnapshot(fixture: string): Promise<string> {
  const emulator = new HeadlessEmulator(grid)
  await emulator.write(fixture.slice(-64 * 1024))
  const snapshot = emulator.getSnapshot({ scrollbackRows: 0 })
  emulator.dispose()
  return snapshot.rehydrateSequences + snapshot.snapshotAnsi
}

async function run(label: string): Promise<void> {
  const fixture: string = buildFixture('agent-tui', BYTES_PER_PTY, grid.cols, grid.rows)
  const screen = await screenSnapshot(fixture)
  let captures = 0
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (ptyId: string) => {
      captures++
      // A daemon round trip: answer on a later turn, at the stream position main has reached.
      await new Promise((resolve) => setImmediate(resolve))
      return {
        data: screen,
        ...grid,
        seq: runtime.getPtyOutputSequence(ptyId),
        source: 'headless'
      } satisfies PtyProviderBufferSnapshot
    }
  })
  // Attribute main-thread time to model creation and seeding (B only has the seed path).
  const timed = { create: 0, creates: 0, seed: 0, seeds: 0 }
  const rt = runtime as unknown as Record<string, (...args: unknown[]) => unknown>
  const wrap = (name: string, key: 'create' | 'seed') => {
    const original = rt[name]?.bind(runtime)
    if (!original) {
      return
    }
    rt[name] = (...args: unknown[]) => {
      const s = performance.now()
      const result = original(...args)
      if (result instanceof Promise) {
        return result.finally(() => {
          timed[key] += performance.now() - s
          timed[key === 'create' ? 'creates' : 'seeds']++
        })
      }
      timed[key] += performance.now() - s
      timed[key === 'create' ? 'creates' : 'seeds']++
      return result
    }
  }
  wrap('createPtyHeadlessTerminalState', 'create')
  wrap('writeProviderSnapshotScreen', 'seed')
  const chunks: string[] = []
  for (let o = 0; o < fixture.length; o += CHUNK) {
    chunks.push(fixture.slice(o, o + CHUNK))
  }
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  let at = 1
  let syncMs = 0
  let gaps = 0
  let maxRoundMs = 0
  for (let c = 0; c < chunks.length; c++) {
    const r0 = performance.now()
    for (let p = 0; p < PTYS; p++) {
      const s = performance.now()
      if (c > 0 && c % GAP_EVERY_CHUNKS === 0) {
        runtime.notePtyDataGap(`pty-${p}`, DROPPED_CHARS)
        gaps++
      }
      runtime.onPtyData(`pty-${p}`, chunks[c], at++)
      syncMs += performance.now() - s
    }
    await new Promise((resolve) => setImmediate(resolve))
    maxRoundMs = Math.max(maxRoundMs, performance.now() - r0)
  }
  const states = (
    runtime as unknown as { headlessTerminals: Map<string, { writeChain: Promise<void> }> }
  ).headlessTerminals
  for (let i = 0; i < 20; i++) {
    await Promise.all([...states.values()].map((s) => s.writeChain))
    await new Promise((resolve) => setImmediate(resolve))
  }
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  h.disable()
  const mib = (fixture.length * PTYS) / 1024 / 1024
  console.log(
    `[gap-storm] ${label}: ptys=${PTYS} MiB=${mib.toFixed(0)} gaps=${gaps} captures=${captures} wall=${wallMs.toFixed(0)}ms onPtyDataSync=${syncMs.toFixed(0)}ms cpu=${((cpu.user + cpu.system) / 1000).toFixed(0)}ms maxRound=${maxRoundMs.toFixed(1)}ms loopMax=${(h.max / 1e6).toFixed(1)}ms p99=${(h.percentile(99) / 1e6).toFixed(1)}ms creates=${timed.creates}/${timed.create.toFixed(0)}ms seeds=${timed.seeds}/${timed.seed.toFixed(0)}ms(wall incl. awaits)`
  )
  for (let p = 0; p < PTYS; p++) {
    await runtime.onPtyExit(`pty-${p}`, 0)
  }
}

it('measures main-side cost of a gap storm', async () => {
  await run('warmup')
  for (let i = 0; i < 5; i++) {
    await run(`${process.env.STORM_ARM ?? '?'}-${i}`)
  }
}, 900_000)
