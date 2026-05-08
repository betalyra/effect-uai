---
name: effect-uai-migrate
description: Use when the user is upgrading effect-uai across versions, sees compile errors after a version bump, or asks Claude to "update my effect-uai code to the latest". Encodes per-version rename tables and behavior changes so Claude can rewrite call sites mechanically without re-reading the changelog each time.
license: MIT
---

# effect-uai migrate

Use this skill when the user is upgrading from one effect-uai release
to a newer one. It contains the consolidated rename and removal rules
for each release, in the form Claude needs to apply rewrites:
"if you see X, write Y, here's the why."

Reach for this when the user says any of:

- "I bumped effect-uai and everything broke"
- "Update my code to the latest effect-uai"
- "What changed in 0.3?"
- "How do I migrate from 0.2 to 0.3?"

## How to use this skill

1. Identify the source version (look at `package.json` or ask).
2. Walk the version tables below in order, applying each rewrite to
   the user's code.
3. After each rewrite, run typecheck (`pnpm typecheck` or equivalent)
   to confirm.
4. Skip "optional" rewrites unless the user asks to modernize.

The full migration prose (with rationale and edge cases) lives in
`docs/migrations/v{X.Y}.md`. This skill is the operator-mode summary.

---

## 0.2 → 0.3

### Required rewrites

#### Rename: `streamUntilComplete` → `onTurnComplete`

```ts
// Before
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
stream.pipe(streamUntilComplete<State, ToolEvent>((turn) => ...))

// After
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
stream.pipe(onTurnComplete<State, ToolEvent>((turn) => ...))
```

Pure rename. Replace the import and the call site. No behavior change.

#### Rename + reshape: `Toolkit.nextStateFrom` → `Toolkit.continueWith`

```ts
// Before
const events = Toolkit.executeAll(tools, calls)
return Toolkit.nextStateFrom(events, (results) =>
  Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
)

// After (preferred — pipe form)
return Toolkit.executeAll(tools, calls).pipe(
  Toolkit.continueWith((results) =>
    Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
  ),
)
```

`continueWith` is `Function.dual`-curried, so both forms type-check.
Use the pipe form unless `events` is assembled from multiple streams
(e.g. the queue-based approval flow), in which case keep the
intermediate `const events =`.

#### Removed: `@effect-uai/core/Match` / `matchType`

```ts
// Before
import { matchType } from "@effect-uai/core/Match"
const handler = matchType<ToolEvent>()({ Intermediate: ..., Output: ..., ApprovalRequested: ... })

// After
import { Match } from "effect"
const handler = Match.discriminators("_tag")({ Intermediate: ..., Output: ..., ApprovalRequested: ... })
```

Use `Match.discriminatorsExhaustive` if exhaustiveness checking is
desired.

### Optional modernizations

#### Tool requirements via `R`

If the user has tools that need API keys, DB handles, or other
services, they can now flow them via Effect's `R` channel:

```ts
class WeatherApiKey extends Context.Service<WeatherApiKey, { key: string }>()(
  "app/WeatherApiKey",
) {}

const lookupWeather = Tool.make({
  name: "lookup_weather",
  inputSchema: ...,
  run: ({ city }) =>
    Effect.gen(function* () {
      const { key } = yield* WeatherApiKey
      return yield* fetchWeather(key, city)
    }),
})

// `executeAll` infers `Stream<ToolEvent, never, WeatherApiKey>`
const events = Toolkit.executeAll([lookupWeather], calls)
events.pipe(Stream.provide(Layer.succeed(WeatherApiKey, { key: "..." })))
```

Pre-0.3 users typically captured services in closures or threaded
them through manually. They can keep doing that — the `R` channel is
opt-in.

#### `Loop.loopWithState` for post-loop state

```ts
const { stream, state } = yield* loopWithState(initial, body)
yield* Stream.runDrain(stream)
const final = yield* SubscriptionRef.get(state)

// Or observe live:
SubscriptionRef.changes(state).pipe(Stream.runForEach(...))
```

Use when callers need to inspect state after the loop drains, or
observe state transitions concurrently. Otherwise stay on `loop`.

#### `Data.TaggedEnum` constructors

`ToolResult`, `ToolEvent`, and `Image*Source` are now tagged enums.
Existing `_tag` literal pattern-matching and `isValue` / `isFailure`
predicates still work; the new shape is purely additive.

```ts
ToolResult.Failure({ call_id, tool, kind: "denied" })  // constructor
ToolResult.$is("Failure")(result)                       // predicate
ToolResult.$match({ Value: ..., Failure: ... })(result) // matcher
```

### After-migration checklist

- [ ] No remaining `streamUntilComplete` references
- [ ] No remaining `nextStateFrom` references
- [ ] No imports from `@effect-uai/core/Match`
- [ ] `pnpm typecheck` clean
- [ ] Tests pass

---

## 0.1 → 0.2

(Not yet documented in this skill. See `packages/core/CHANGELOG.md`.)

---

## When this skill should *not* run

- User is starting a new project — point them at `effect-uai-basic-usage`.
- User is on the latest version and asking how a specific API works —
  point them at the relevant feature skill (`effect-uai-tool-call-approval`,
  `effect-uai-streaming-tool-output`, etc.) or the docs.
- Breaking change is in user code, not in effect-uai — apply normal
  Effect debugging.

## See also

- [Migration guide for 0.3](https://effect-uai.betalyra.com/migrations/v0-3/)
- `packages/core/CHANGELOG.md` for the per-PR record
- Feature skills under `skills/` for new-code patterns
