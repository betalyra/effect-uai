---
"@effect-uai/core": minor
---

Move to Effect 4.0 stable. The `effect` peer range rises from `>=4.0.0-rc.111 <5.0.0` to `>=4.0.1 <5.0.0`; upgrade your app to `effect@4.0.1` or newer. Every package's built output now imports `effect/http`, `effect/socket` and the other modules that 4.0 moved out of `effect/unstable/*`, so a release candidate no longer resolves.

effect-uai's own API renames nothing for this. If your code uses Effect directly, 4.0 itself brings three renames you may hit:

- `effect/unstable/<module>` is now `effect/<module>`, e.g. `effect/unstable/http` is `effect/http`.
- `Encoding` left the `effect` root: `Encoding.encodeBase64` / `decodeBase64` are `Base64.encode` / `Base64.decode` from `effect/encoding`.
- `Config` constructors are PascalCase: `Config.redacted` is `Config.Redacted`, `Config.string` is `Config.String`, and so on. `Config.option`, `orElse` and `withDefault` are unchanged.

`@effect-uai/core/WebSocketSession` gains `isCleanClose`: Effect 4.0's `Socket` fails its reader on every close, so this is the one place that reads 1000, 1001 and 1005 as a normal end. `open` keeps its `send` / `frames` shape; a `send` after the socket closes still fails `Unavailable` rather than waiting for a reconnect.

`@effect-uai/core/testing/FakeWebSocket` gains `greeted` and `awaitSent(count)`, so a test can wait for the client to subscribe or to send a number of frames instead of sleeping.
