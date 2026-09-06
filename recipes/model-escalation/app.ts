/**
 * Composition for the model-escalation recipe. Reads a line from
 * stdin, appends it to a running conversation, runs one round (cheap tier
 * first; cheap may escalate to a strong tier via a tool call), streams the
 * reply, and prompts again. Conversation history accumulates across
 * messages. Ctrl-C exits.
 *
 * Pick a provider with `--provider <openai|anthropic|google>` (default
 * `openai`).
 *
 * Try one easy and one hard question in the same session:
 *   you> What's the capital of Portugal?
 *   you> Why does a quantum harmonic oscillator have non-zero ground-state energy?
 *
 * The two tiers share one provider service and differ only by model name,
 * so they are built here rather than through `_shared/model.ts`, which hands
 * back Layers rather than the service value a `Tier` carries.
 */
import * as readline from "node:readline"
import {
  Config,
  Effect,
  Layer,
  Logger,
  Match,
  Option,
  Queue,
  Ref,
  References,
  Stream,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { providerChoice } from "@effect-uai/recipe-kit/argv"
import {
  type ConversationEvent,
  type Tier,
  conversation,
  initialState,
  lastTurn,
} from "./recipe.js"

type Provider = "openai" | "anthropic" | "google"

// ---------------------------------------------------------------------------
// Provider-specific cheap/strong pairs.
// ---------------------------------------------------------------------------

const makeTiers = Match.type<Provider>().pipe(
  Match.when("openai", () =>
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("OPENAI_API_KEY")
      const service = yield* makeResponses({ apiKey })
      return [
        { name: "openai/gpt-5.4-mini", model: "gpt-5.4-mini", service },
        { name: "openai/gpt-5.4", model: "gpt-5.4", service },
      ] as const satisfies readonly [Tier, Tier]
    }),
  ),
  Match.when("anthropic", () =>
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY")
      const service = yield* makeAnthropic({ apiKey, defaultMaxTokens: 1024 })
      return [
        { name: "anthropic/claude-haiku-4-5", model: "claude-haiku-4-5", service },
        { name: "anthropic/claude-sonnet-4-6", model: "claude-sonnet-4-6", service },
      ] as const satisfies readonly [Tier, Tier]
    }),
  ),
  Match.when("google", () =>
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
      const service = yield* makeGemini({ apiKey })
      return [
        {
          name: "google/gemini-3-flash-preview",
          model: "gemini-3-flash-preview",
          service,
        },
        {
          name: "google/gemini-3.1-pro-preview",
          model: "gemini-3.1-pro-preview",
          service,
        },
      ] as const satisfies readonly [Tier, Tier]
    }),
  ),
  Match.exhaustive,
)

// ---------------------------------------------------------------------------
// stdin -> queue of user messages.
// ---------------------------------------------------------------------------

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

const readStdinInto = (queue: Queue.Queue<string>): Effect.Effect<never> =>
  Effect.callback<never>((resume) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed.length > 0) Queue.offerUnsafe(queue, trimmed)
    })
    rl.on("close", () => resume(Effect.interrupt))
    return Effect.sync(() => rl.close())
  })

// ---------------------------------------------------------------------------
// Render one round of the conversation onto stdout. Text deltas stream
// inline; tier transitions and escalation events render as labeled asides
// so you can see which model is talking and why it switched.
// ---------------------------------------------------------------------------

const renderEvent = (event: ConversationEvent): Effect.Effect<void> =>
  Match.value(event).pipe(
    Match.when({ _tag: "tier_active" }, ({ tier, model }) =>
      write(tier === "cheap" ? `\n[cheap: ${model}] ` : `\n[strong: ${model}] `),
    ),
    Match.when({ _tag: "escalated" }, ({ reason }) => write(`\n  ↳ escalating: ${reason}\n`)),
    Match.discriminators("_tag")({
      TextDelta: ({ text }) => write(text),
      TurnComplete: () => Effect.void,
    }),
    Match.orElse(() => Effect.void),
  )

// ---------------------------------------------------------------------------
// Program: one stdin line = one round. History accumulates across rounds
// via a Ref of `Item[]` (user/assistant items only; the cheap-tier system
// prompt is prepended inside the loop, not stored).
// ---------------------------------------------------------------------------

const program = (cheap: Tier, strong: Tier) =>
  Effect.gen(function* () {
    yield* write(
      "model-escalation chat. Try an easy question and a hard one.\nCtrl-C to exit.\n\nyou> ",
    )

    const queue = yield* Queue.unbounded<string>()
    yield* Effect.forkChild(readStdinInto(queue))

    const convo = conversation(cheap, strong)
    const historyRef = yield* Ref.make<ReadonlyArray<Items.HistoryItem>>([])

    return yield* Effect.forever(
      Effect.gen(function* () {
        const message = yield* Queue.take(queue)
        const prior = yield* Ref.get(historyRef)

        const events = yield* Stream.runCollect(
          convo(initialState(message, prior)).pipe(Stream.tap(renderEvent)),
        )

        // Accumulate the final assistant turn (the strong tier's, if
        // escalation happened; otherwise the cheap tier's) into history.
        // The cheap tier's turn is intentionally dropped on escalation -
        // its text + escalate call would only confuse later turns.
        yield* Option.match(lastTurn(events), {
          onNone: () => Effect.void,
          onSome: (turn) => Ref.set(historyRef, [...prior, Items.userText(message), ...turn.items]),
        })

        yield* write("\n\nyou> ")
      }),
    )
  })

export const main = Effect.gen(function* () {
  const provider = yield* providerChoice("openai", "anthropic", "google")
  yield* Effect.logInfo("provider", { provider })
  const [cheap, strong] = yield* makeTiers(provider)
  yield* program(cheap, strong)
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
