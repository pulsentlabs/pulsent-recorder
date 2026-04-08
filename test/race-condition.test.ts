/**
 * Test that demonstrates the race condition with the old PulsentRecorder.init()
 * vs the new beforeSendHandler() approach.
 *
 * Simulates: PostHog starts recording from persisted config during init(),
 * flushes $snapshot events BEFORE the loaded callback fires.
 *
 * Run: cd sdk && npx tsx test/race-condition.test.ts
 */

import { PulsentRecorder } from "../src/index"

// ─── Mocks ──────────────────────────────────────────────────────────
const fetchCalls: { session_id: string; events: number }[] = []
;(globalThis as any).fetch = (url: string, opts: any) => {
  const body = JSON.parse(opts.body)
  fetchCalls.push({ session_id: body.session_id, events: body.snapshot_data.length })
  return Promise.resolve({ ok: true, status: 200, statusText: "OK" })
}

Object.defineProperty(globalThis, "navigator", {
  value: { sendBeacon: () => true },
  writable: true,
  configurable: true,
})
;(globalThis as any).window = {
  addEventListener() {},
  removeEventListener() {},
}

// ─── Simulate PostHog with recording from persisted config ──────────
type BeforeSendFn = (event: any) => any

function simulatePostHog(opts: {
  before_send?: BeforeSendFn
  loaded?: (ph: any) => void
}) {
  let beforeSend: BeforeSendFn | null = opts.before_send ?? null

  const ph = {
    config: {
      token: "phc_test_token_12345",
      before_send: beforeSend,
    },
    set_config(cfg: any) {
      if (cfg.before_send !== undefined) {
        beforeSend = cfg.before_send
        ph.config.before_send = cfg.before_send
      }
    },
    onSessionId(cb: Function) {
      cb("session-1", "win-1", null)
      return () => {}
    },
    // Simulate capture — runs before_send if present
    capture(eventName: string, properties: any) {
      const event = { event: eventName, properties }
      if (beforeSend) {
        if (Array.isArray(beforeSend)) {
          let e = event
          for (const fn of beforeSend) e = fn(e)
        } else {
          beforeSend(event)
        }
      }
    },
  }

  // ── Simulate PostHog init flow ──
  // Step 1: set_config with user config (including before_send if provided)
  // (already done via constructor above)

  // Step 2: Recording starts from PERSISTED config (before loaded callback!)
  // This is the race: rrweb fires, buffer flushes, capture("$snapshot") is called
  ph.capture("$snapshot", {
    $session_id: "session-1",
    $window_id: "win-1",
    $snapshot_data: [
      { type: 2, timestamp: 1000 }, // FullSnapshot — the critical initial frame
      { type: 4, timestamp: 1001 }, // Meta
      { type: 3, timestamp: 1002 }, // IncrementalSnapshot
      { type: 3, timestamp: 1003 },
      { type: 3, timestamp: 1004 },
    ],
    distinct_id: "user-1",
  })

  // Step 3: loaded callback fires
  if (opts.loaded) opts.loaded(ph)

  // Step 4: More snapshots arrive (after loaded)
  ph.capture("$snapshot", {
    $session_id: "session-1",
    $window_id: "win-1",
    $snapshot_data: [
      { type: 3, timestamp: 2000 },
      { type: 3, timestamp: 2001 },
      { type: 3, timestamp: 2002 },
    ],
    distinct_id: "user-1",
  })

  return ph
}

// ─── Helpers ────────────────────────────────────────────────────────
let passed = 0
let failed = 0
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

// ─── Test 1: Old approach — PulsentRecorder.init() in loaded callback ─
console.log("\nTest 1: OLD approach — PulsentRecorder.init() in loaded callback\n")
fetchCalls.length = 0

simulatePostHog({
  loaded: (ph) => {
    PulsentRecorder.init({ posthog: ph })
  },
})

await new Promise((r) => setTimeout(r, 50))

const oldTotal = fetchCalls.reduce((sum, c) => sum + c.events, 0)
console.log(`  Captured: ${fetchCalls.length} batches, ${oldTotal} events`)
assert(fetchCalls.length === 1, "only captured 1 batch (missed the early one)")
assert(oldTotal === 3, "only 3 events captured (missed 5 from initial snapshot)")

// ─── Test 2: New approach — beforeSendHandler ───────────────────────
console.log("\nTest 2: NEW approach — beforeSendHandler() in config\n")
fetchCalls.length = 0

const swish = PulsentRecorder.beforeSendHandler()

simulatePostHog({
  before_send: swish.handler,
  loaded: (ph) => swish.bind(ph),
})

await new Promise((r) => setTimeout(r, 50))

const newTotal = fetchCalls.reduce((sum, c) => sum + c.events, 0)
console.log(`  Captured: ${fetchCalls.length} batches, ${newTotal} events`)
assert(fetchCalls.length === 2, "captured both batches")
assert(newTotal === 8, "all 8 events captured (5 initial + 3 subsequent)")

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\nOLD: ${oldTotal}/8 events (${((oldTotal/8)*100).toFixed(0)}%)`)
console.log(`NEW: ${newTotal}/8 events (${((newTotal/8)*100).toFixed(0)}%)`)
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
