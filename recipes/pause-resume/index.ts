/**
 * Soft pause / resume of an in-flight agent loop using `Latch`. The body
 * waits on the latch before each iteration; closing it pauses the loop
 * (no new `streamTurn` is initiated, no HTTP connection held), opening it
 * resumes. State threads through the loop naturally, so resume picks up
 * exactly where pause left off - no checkpoint to write.
 *
 * The demo gates pause/resume on turn count via a shared `Ref` so the
 * pause lands at a known point regardless of how fast the model responds.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/pause-resume/index.ts`
 */
import {
  Config,
  Effect,
  Fiber,
  Latch,
  Layer,
  Logger,
  Match,
  Ref,
  References,
  Stream,
  pipe,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { loop, nextAfter, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { Responses, layer as responsesLayer } from "@effect-uai/responses/Responses"

// ---------------------------------------------------------------------------
// Demo configuration
// ---------------------------------------------------------------------------

const PAUSE_AFTER_TURN = 3
const PAUSE_DURATION = "30 seconds"

const PROMPT_BANK = [
  "Tell me one short fact about Lisbon.",
  "Now Tokyo.",
  "Now Rio.",
  "Now Paris.",
  "Now Cairo.",
  "Now London.",
]

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.Item>
  readonly pendingPrompts: ReadonlyArray<string>
}

const initial: State = {
  history: [Items.userText(PROMPT_BANK[0]!)],
  pendingPrompts: PROMPT_BANK.slice(1),
}

const advance = (state: State, turn: Turn.Turn): State => ({
  history: [...state.history, ...turn.items],
  pendingPrompts: state.pendingPrompts,
})

// ---------------------------------------------------------------------------
// The loop - one `Latch.await` at the top is the entire pause mechanism.
// ---------------------------------------------------------------------------

const conversation = (pauseLatch: Latch.Latch, turnsCompleted: Ref.Ref<number>) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        // Pause point: returns immediately if open, blocks if closed.
        yield* Latch.await(pauseLatch)

        const oai = yield* Responses
        return oai
          .streamTurn({
            history: state.history,
            model: "gpt-5.4-mini",
            tools: [],
            reasoning: { effort: "low" },
          })
          .pipe(
            streamUntilComplete((turn) =>
              Effect.gen(function* () {
                yield* Ref.update(turnsCompleted, (n) => n + 1)
                const next = advance(state, turn)
                if (next.pendingPrompts.length === 0) return stop
                const [nextPrompt, ...rest] = next.pendingPrompts
                return nextAfter(Stream.empty, {
                  ...next,
                  history: [...next.history, Items.userText(nextPrompt!)],
                  pendingPrompts: rest,
                })
              }),
            ),
          )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// External controller - in a real app this is a UI button / signal handler.
// ---------------------------------------------------------------------------

const pauseController = (pauseLatch: Latch.Latch, turnsCompleted: Ref.Ref<number>) =>
  Effect.gen(function* () {
    // Wait until the loop has done PAUSE_AFTER_TURN turns.
    yield* Effect.repeat(
      Effect.gen(function* () {
        const n = yield* Ref.get(turnsCompleted)
        if (n < PAUSE_AFTER_TURN) {
          yield* Effect.sleep("100 millis")
          return false
        }
        return true
      }),
      { until: (done) => done },
    )

    yield* Effect.logInfo(`pause - holding for ${PAUSE_DURATION}`)
    yield* Latch.close(pauseLatch)

    yield* Effect.sleep(PAUSE_DURATION)

    yield* Effect.logInfo("resume")
    yield* Latch.open(pauseLatch)
  })

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const pauseLatch = yield* Latch.make(true) // start open
  const turnsCompleted = yield* Ref.make(0)

  const controllerFiber = yield* Effect.forkChild(pauseController(pauseLatch, turnsCompleted))

  yield* Stream.runForEach(conversation(pauseLatch, turnsCompleted), (event) =>
    Match.value(event).pipe(
      Match.discriminators("type")({
        turn_complete: ({ turn }) =>
          Effect.logInfo("turn complete", {
            assistant: Turn.assistantMessages(turn)
              .flatMap((m) => m.content)
              .filter(Items.isOutputText)
              .map((c) => c.text)
              .join(" "),
          }),
      }),
      Match.orElse(() => Effect.void),
    ),
  )

  yield* Fiber.join(controllerFiber)
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const mainLayer = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
