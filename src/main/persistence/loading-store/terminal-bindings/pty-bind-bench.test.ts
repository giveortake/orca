// SCRATCH BENCH, not for merge: main-thread time of PTY bind/retire mutations on a ~9M-char session.
/* oxlint-disable typescript/no-explicit-any */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../../profile-state-cutover-fixture'
import { ProfileStateSqliteAuthority } from '../../profile-state/profile-state-sqlite-authority'
import { DelayedAuthority } from '../profile-writing/profile-state-delayed-authority-fixture'
import { Store } from '../store'

const WORKTREES = Number(process.env.BENCH_WORKTREES ?? 1900)
const TABS = 3
const SCROLLBACK_CHARS = Number(process.env.BENCH_SCROLLBACK ?? 1300)
const SINGLE = Number(process.env.BENCH_SINGLE ?? 12)
const BURST = Number(process.env.BENCH_BURST ?? 1900)
const BURST_BUDGET_MS = Number(process.env.BENCH_BURST_BUDGET_MS ?? 240_000)

function bigSession(base: Record<string, any>) {
  const session = structuredClone(base.workspaceSession)
  const repoId = Object.keys(session.tabsByWorktree)[0]?.split('::')[0] ?? 'repo-local'
  const line = 'x'.repeat(SCROLLBACK_CHARS)
  session.tabsByWorktree = { ...session.tabsByWorktree }
  session.terminalLayoutsByTabId = { ...session.terminalLayoutsByTabId }
  session.localOnlyScrollbackByTabId = {}
  session.activeTabIdByWorktree = {}
  const worktreeIds: string[] = []
  for (let w = 0; w < WORKTREES; w++) {
    const worktreeId = `${repoId}::/fixture/wt-${w}`
    worktreeIds.push(worktreeId)
    const tabs = []
    for (let t = 0; t < TABS; t++) {
      const id = `tab-${w}-${t}`
      const leaf = randomUUID()
      tabs.push({
        id,
        ptyId: null,
        worktreeId,
        title: `Terminal ${t + 1}`,
        customTitle: null,
        color: null,
        sortOrder: t,
        createdAt: 1_700_000_000_000 + w * 10 + t
      })
      session.terminalLayoutsByTabId[id] = {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        titlesByLeafId: { [leaf]: `zsh ${w}/${t}` }
      }
      session.localOnlyScrollbackByTabId[id] = { [leaf]: `${id}:${line}` }
    }
    session.tabsByWorktree[worktreeId] = tabs
    session.activeTabIdByWorktree[worktreeId] = `tab-${w}-0`
  }
  return { session, worktreeIds }
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? Number.NaN
  const sum = s.reduce((a, b) => a + b, 0)
  return `n=${s.length} p50=${q(0.5).toFixed(1)}ms p95=${q(0.95).toFixed(1)}ms max=${(s.at(-1) ?? Number.NaN).toFixed(1)}ms total=${(sum / 1000).toFixed(2)}s`
}

it('pty bind main-thread bench', { timeout: 900_000 }, async () => {
  vi.stubEnv('VITEST', '')
  const directory = mkdtempSync(join(tmpdir(), 'orca-pty-bench-'))
  const path = join(directory, 'profile-state.db')
  const inner = new ProfileStateSqliteAuthority(path, 'bench')
  const initial: Record<string, any> = buildProfileStateCutoverFixture(directory)
  const built = bigSession(initial)
  initial.workspaceSession = built.session
  inner.writeSerializedState(Buffer.from(JSON.stringify(initial)))
  const authority = new DelayedAuthority(inner)
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  const samples: number[] = []
  const original = (store as any).runDurableMutation.bind(store)
  ;(store as any).runDurableMutation = (mutate: (...a: unknown[]) => unknown) =>
    original((...args: unknown[]) => {
      const start = performance.now()
      try {
        return mutate(...args)
      } finally {
        samples.push(performance.now() - start)
      }
    })
  try {
    await store.flushPendingOrThrowAsync()
    const sessionChars = JSON.stringify(store.getWorkspaceSession()).length
    const bind = (w: number, round: string) => ({
      worktreeId: built.worktreeIds[w]!,
      tabId: `bench-${round}-${w}`,
      leafId: randomUUID(),
      ptyId: `bench-pty-${round}-${w}`,
      incarnationId: `inc-${round}-${w}`
    })
    // Single spawns: one bind then one retire at a time.
    const binds: number[] = []
    const retires: number[] = []
    for (let i = 0; i < SINGLE + 2; i++) {
      const args = bind(i, 'single')
      samples.length = 0
      if (!(await store.persistPtyBinding(args))) {
        throw new Error('bind refused')
      }
      if (i >= 2) {
        binds.push(samples.reduce((a, b) => a + b, 0))
      }
      samples.length = 0
      if (!(await store.retirePtyBinding(args))) {
        throw new Error('retire refused')
      }
      if (i >= 2) {
        retires.push(samples.reduce((a, b) => a + b, 0))
      }
    }
    // Burst: BURST spawns issued at once; binds past the budget are dropped cheaply.
    samples.length = 0
    const deadline = performance.now() + BURST_BUDGET_MS
    let done = 0
    const wall = performance.now()
    const results = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        store.persistPtyBinding(() => {
          if (performance.now() > deadline) {
            return null
          }
          done += 1
          return bind(i % built.worktreeIds.length, 'burst')
        })
      )
    )
    const wallMs = performance.now() - wall
    const burstSamples = samples.slice()
    console.log(
      `BENCH sessionChars=${sessionChars} worktrees=${WORKTREES}\n` +
        `BENCH bind   ${stats(binds)}\nBENCH retire ${stats(retires)}\n` +
        `BENCH burst issued=${BURST} bound=${done} accepted=${results.filter(Boolean).length} wall=${(wallMs / 1000).toFixed(1)}s mutations ${stats(burstSamples)}`
    )
  } finally {
    await store.freezeWritesAsync()
    rmSync(directory, { recursive: true, force: true })
  }
})
