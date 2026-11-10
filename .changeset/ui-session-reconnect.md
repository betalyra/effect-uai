---
"@effect-uai/ui": minor
---

Durable transports: `Transport.reconnect`, early ends as errors, hydrated sessions, SSE heartbeats.

- **Breaking:** `reconnect` moves from `sessionHttp` / `durableHttp` options to `Transport.reconnect(transport, options?)` (also `pipe(transport, Transport.reconnect(options))`). It takes any `Transport.session` / `Transport.durable`, WebSocket and RPC sources included, and resumes from the last `seq`. It retries only transient errors: a drop (`Client.Disconnected`), a timeout, a transport error, 408 / 429 / 5xx and an SSE `retry:` line, waiting at least the server's `Retry-After` / `retry:`. A 404, 401 or malformed frame ends the stream with that error instead of reconnecting forever. `while` adds the app's own transient errors, typed by the transport; `schedule` and `times` as in `HttpClient.retryTransient`. Default backoff: exponential from 500 ms, capped at 10 s, jittered. A durable `submit` is never retried.
- **Breaking:** a session stream that completes, or a durable run's stream that completes before its terminal, now fails with `Client.Disconnected` instead of completing quietly. The `open` / `resume` atom shows the failure and `ended(…, "disconnected")` runs.
- **Breaking:** `Transport.Durable` carries `submit`; `start` is `submit`, then `resume(streamId, 0)`.
- `Atoms.session` / `sessionThread`: `open({ streamId, after })` follows a stream from a position (a bare id still means from the start). `sessionThread({ initial })` starts from a thread loaded elsewhere; it sets the state only.
- `SseEncoding.heartbeat(interval)` interleaves SSE comments so proxies don't close an idle stream.
- `Client.resumable`'s `schedule` is optional: without one, an early end fails with `Disconnected` and nothing is retried.
- The `effect` peer range is `>=4.1.0 <5.0.0` (`HttpClient.isTransientError`).
