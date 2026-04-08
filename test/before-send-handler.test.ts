/**
 * Quick local test for PulsentRecorder.beforeSendHandler()
 *
 * Run: cd sdk && npx tsup && node test/before-send-handler.test.mjs
 */

import { PulsentRecorder } from "../src/index"

// ─── Mock PostHog ───────────────────────────────────────────────────
let configStore: Record<string, unknown> = {}
let sessionIdCallback: Function | null = null

const mockPostHog = {
  config: { token: "phc_test_token_12345", before_send: undefined as unknown },
  set_config(cfg: Record<string, unknown>) {
    Object.assign(configStore, cfg)
    if (cfg.before_send) this.config.before_send = cfg.before_send
  },
  onSessionId(cb: Function) {
    sessionIdCallback = cb
    return () => { sessionIdCallback = null }
  },
}

// ─── Mock fetch ─────────────────────────────────────────────────────
const fetchCalls: { url: string; body: any }[] = []
;(globalThis as any).fetch = (url: string, opts: any) => {
  fetchCalls.push({ url, body: JSON.parse(opts.body) })
  return Promise.resolve({ ok: true, status: 200, statusText: "OK" })
}

// ─── Mock navigator.sendBeacon ──────────────────────────────────────
const beaconCalls: { url: string; body: any }[] = []
Object.defineProperty(globalThis, "navigator", {
  value: {
    sendBeacon(url: string, _blob: unknown) {
      beaconCalls.push({ url, body: null })
      return true
    },
  },
  writable: true,
  configurable: true,
})

// ─── Mock window ────────────────────────────────────────────────────
const windowListeners: Record<string, Function> = {}
;(globalThis as any).window = {
  addEventListener(event: string, handler: Function) {
    windowListeners[event] = handler
  },
  removeEventListener(event: string, _handler: Function) {
    delete windowListeners[event]
  },
}

// ─── Helpers ────────────────────────────────────────────────────────
function makeSnapshotEvent(sessionId: string, data: unknown[] = [{ type: 3, timestamp: Date.now() }]) {
  return {
    event: "$snapshot",
    properties: {
      $session_id: sessionId,
      $window_id: "win-1",
      $snapshot_data: data,
      distinct_id: "user-1",
    },
  }
}

let passed = 0
let failed = 0
function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

// ─── Tests ──────────────────────────────────────────────────────────
console.log("\nbeforeSendHandler tests\n")

// Test 1: handler buffers snapshots BEFORE bind (no token yet, no fetch)
console.log("1. Handler buffers snapshots before bind()")
const swish = PulsentRecorder.beforeSendHandler({ debug: false })
const event1 = makeSnapshotEvent("session-1")

fetchCalls.length = 0
swish.handler(event1)
await new Promise((r) => setTimeout(r, 10))
assert(fetchCalls.length === 0, "no fetch before bind (buffered, no token)")

// Test 2: handler returns event unchanged
console.log("\n2. Handler returns event unchanged (non-destructive)")
const returned = swish.handler(event1)
assert(returned === event1, "event passed through unchanged")

// Test 3: after bind, handler flushes buffered + captures new
console.log("\n3. After bind(), handler flushes buffer and captures new snapshots")
fetchCalls.length = 0
swish.bind(mockPostHog as any)
await new Promise((r) => setTimeout(r, 10))
const bufferedCount = fetchCalls.length
assert(bufferedCount === 2, `bind() flushed ${bufferedCount} buffered snapshot(s) (1 from test 1 + 1 from test 2)`)
assert(fetchCalls[0].body.session_id === "session-1", "flushed snapshot has correct session_id")

// Now send a new snapshot post-bind
fetchCalls.length = 0
const event2 = makeSnapshotEvent("session-2", [
  { type: 2, timestamp: Date.now() },
  { type: 3, timestamp: Date.now() + 100 },
])
swish.handler(event2)
await new Promise((r) => setTimeout(r, 10))
assert(fetchCalls.length === 1, "new snapshot sent immediately")
assert(fetchCalls[0].body.session_id === "session-2", "correct session_id")
assert(fetchCalls[0].body.snapshot_data.length === 2, "snapshot_data contains 2 events")

// Test 4: non-snapshot events pass through without fetch
console.log("\n4. Non-snapshot events pass through")
fetchCalls.length = 0
const pageview = { event: "$pageview", properties: { $current_url: "/test" } }
const result = swish.handler(pageview)
await new Promise((r) => setTimeout(r, 10))
assert(result === pageview, "pageview returned unchanged")
assert(fetchCalls.length === 0, "no fetch for pageview")

// Test 5: bind() wires up session lifecycle (onSessionId, beforeunload)
console.log("\n5. bind() sets up session lifecycle")
assert(sessionIdCallback !== null, "onSessionId callback registered")
assert("beforeunload" in windowListeners, "beforeunload listener registered")

// Test 6: null event handled gracefully
console.log("\n6. Null event handled gracefully")
const nullResult = swish.handler(null)
assert(nullResult === null, "null returns null")

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
