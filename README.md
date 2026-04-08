# pulsent-recorder

First-party session recording SDK for [Pulsent](https://pulsent.ai). If your app already runs [PostHog](https://posthog.com), this SDK hooks directly into its recording pipeline so you get full-fidelity sessions in Pulsent — with no second recorder, no extra CPU, and no duplicate work.

---

## How it works

PostHog buffers rrweb events and flushes them as `$snapshot` batches every ~2 seconds. `pulsent-recorder` taps into PostHog's `before_send` pipeline to forward each batch to Pulsent alongside the existing PostHog flow. PostHog keeps recording as normal — Pulsent just listens.

```
PostHog JS SDK (already running)
  └── before_send intercepts $snapshot batches
      └── POST https://api.pulsent.ai/replays/ingest
```

Session end is detected through three signals:
- **Session rotation** — `posthog.onSessionId` fires on idle timeout or max session length
- **Tab close** — `navigator.sendBeacon` on `beforeunload`
- **Cron fallback** — 30-minute server-side sweep for sessions with no recent activity

---

## Installation

```bash
npm install pulsent-recorder
# or
pnpm add pulsent-recorder
```

`posthog-js` must already be installed in your project. `pulsent-recorder` has no dependencies of its own.

---

## Usage

### Recommended: `beforeSendHandler` (zero-miss)

Inject the handler directly into PostHog's config so it captures snapshots from the very first event — including the initial DOM snapshot that fires before `loaded` callbacks.

```ts
import posthog from 'posthog-js'
import { PulsentRecorder } from 'pulsent-recorder'

const pulsent = PulsentRecorder.beforeSendHandler()

posthog.init('phc_your_project_token', {
  api_host: 'https://eu.i.posthog.com',
  defaults: '2026-01-30',
  before_send: pulsent.handler,
  loaded: (ph) => pulsent.bind(ph),  // starts session lifecycle tracking
})
```

### React

```tsx
// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'
import { PulsentRecorder } from 'pulsent-recorder'
import App from './App'

const pulsent = PulsentRecorder.beforeSendHandler()

posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN, {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  defaults: '2026-01-30',
  before_send: pulsent.handler,
  loaded: (ph) => pulsent.bind(ph),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PostHogProvider client={posthog}>
      <App />
    </PostHogProvider>
  </StrictMode>
)
```

### React (PostHogProvider only)

```tsx
// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PostHogProvider } from 'posthog-js/react'
import { PulsentRecorder } from 'pulsent-recorder'
import App from './App'

const pulsent = PulsentRecorder.beforeSendHandler()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PostHogProvider
      apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN}
      options={{
        api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
        defaults: '2026-01-30',
        before_send: pulsent.handler,
        loaded: (ph) => pulsent.bind(ph),
      }}
    >
      <App />
    </PostHogProvider>
  </StrictMode>
)
```

### Legacy: `PulsentRecorder.init`

Still works, but may miss the initial DOM snapshot on pages where PostHog starts recording from cached config before the `loaded` callback fires.

```ts
posthog.init('phc_your_project_token', { ... })
PulsentRecorder.init({ posthog })
```

---

## API

### `PulsentRecorder.init(config)`

Starts recording. Returns a `PulsentRecorder` instance.

| Option | Type | Description |
|--------|------|-------------|
| `posthog` | `PostHog` | Your initialized PostHog instance |

### `recorder.destroy()`

Removes all event listeners and stops forwarding snapshots. Optional — only needed if you need explicit cleanup.

---

## Requirements

- `posthog-js` must be initialized with **session recording enabled** before calling `PulsentRecorder.init`
- The PostHog project token must be registered in your Pulsent workspace settings

---

## License

MIT
