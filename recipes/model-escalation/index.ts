/**
 * Model escalation: start on a fast / cheap model with an `escalate` tool;
 * if the model decides the question is out of its depth, it calls
 * `escalate(reason, question)` and the loop hands the (restated) question to
 * a stronger model on the next iteration.
 *
 * Unlike `multi-model-fallback` - which advances tiers on provider failure
 * (`RateLimited`, `Unavailable`) - the model itself decides when to escalate
 * via a tool call, guided by a system prompt that defines the policy.
 *
 * Shape:
 *   tier 0 (cheap)  : streamTurn with `tools: [escalate]` + system prompt.
 *                     On `TurnComplete`:
 *                       - escalate call present → advance to tier 1, fresh
 *                         history `[userText(question)]`.
 *                       - otherwise → `stop`.
 *
 *   tier 1 (strong) : streamTurn with no tools. Terminal; on
 *                     `TurnComplete` → `stop`.
 *
 * The strong tier does not see the cheap tier's chain-of-thought or the
 * `escalate` function call. It gets a fresh, clean history with the restated
 * question, so it doesn't need to know about a tool it can't see.
 *
 * `index.ts` builds the conversation given two tiers. The runner in
 * `run-node.ts` wires real providers (OpenAI / Google / Anthropic).
 */
import { Array as Arr, Effect, Option, Schema, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { loop, next, stop, onTurnComplete, value } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// The escalate "tool". `run` never executes - we intercept the call at
// `onTurnComplete` and translate it into a tier advance. Only the descriptor
// is sent to the cheap tier.
// ---------------------------------------------------------------------------

export const EscalateInput = Schema.Struct({
  reason: Schema.String,
  question: Schema.String,
})
export type EscalateArgs = typeof EscalateInput.Type

export const escalate = Tool.make({
  name: "escalate",
  description:
    "Hand the question off to a stronger, more expensive model. Use when the question requires deep expertise that a fast model can't deliver with high confidence.",
  inputSchema: Tool.fromEffectSchema(EscalateInput),
  run: () => Effect.succeed({ escalated: true }),
  strict: true,
})

const escalateDescriptors = Tool.toDescriptors([escalate])

// ---------------------------------------------------------------------------
// System prompt for the cheap tier. The policy lives here - swap it for any
// rule set ("escalate on quantum physics", "escalate on legal advice", ...).
// ---------------------------------------------------------------------------

export const CHEAP_TIER_SYSTEM_PROMPT = `You are a fast, cheap triage assistant. You have exactly two options for every user message:

  1. Answer directly - only for trivia, definitions, simple lookups, basic factual questions, small talk, and one-line clarifications.
  2. Call the \`escalate\` tool - for EVERYTHING ELSE. When in doubt, escalate.

You MUST call \`escalate\` (not answer in text) whenever the user's message touches ANY of these, even introductory or "explain it simply" framings:

  - Physics beyond high-school basics: quantum mechanics, quantum field theory, relativity, thermodynamics, statistical mechanics, cosmology, particle physics.
  - Mathematics beyond arithmetic / basic algebra: proofs, calculus, linear algebra, differential equations, topology, number theory, statistics beyond mean/median.
  - Chemistry / biology at a mechanistic level (reaction mechanisms, molecular biology, pharmacology).
  - Legal, medical, financial, or tax advice of any kind.
  - Software architecture, distributed systems design, performance analysis, security review.
  - Multi-step reasoning, planning, or anything that would benefit from chain-of-thought.
  - Questions where you would normally hedge ("it depends", "roughly", "I'm not sure but...").
  - Any request explicitly asking for depth, rigor, or expertise.

When you call \`escalate\`:
  - \`reason\`: one short sentence saying why a stronger model is needed.
  - \`question\`: the user's question restated cleanly and self-contained.

CRITICAL: when you escalate, output ONLY the tool call. Do NOT write any text alongside it - no preamble, no apology, no partial answer. The tool call IS your entire response.`

// ---------------------------------------------------------------------------
// Tiers and state
// ---------------------------------------------------------------------------

export interface Tier {
  readonly name: string
  readonly model: string
  readonly service: LanguageModelService
}

export interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly tier: 0 | 1
  readonly escalation?: EscalateArgs
}

// ---------------------------------------------------------------------------
// Custom event emitted alongside the provider's TurnEvent stream so callers
// can see *which tier* is talking and observe the escalation point.
// ---------------------------------------------------------------------------

export type EscalationEvent =
  | { readonly _tag: "tier_active"; readonly tier: "cheap" | "strong"; readonly model: string }
  | { readonly _tag: "escalated"; readonly reason: string; readonly question: string }

export type ConversationEvent = Turn.TurnEvent | EscalationEvent

// ---------------------------------------------------------------------------
// Build initial state for one round. `prior` is the running conversation
// (user/assistant items accumulated by the caller across rounds). The
// cheap-tier system prompt is prepended at request time and is never
// stored in history, so it doesn't bloat the accumulator.
// ---------------------------------------------------------------------------

export const initialState = (
  question: string,
  prior: ReadonlyArray<Items.HistoryItem> = [],
): State => ({
  history: [...prior, Items.userText(question)],
  tier: 0,
})

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

export const conversation = (cheap: Tier, strong: Tier) => (state: State) =>
  pipe(
    state,
    loop((current) =>
      Effect.gen(function* () {
        const tier = current.tier === 0 ? cheap : strong
        const label: "cheap" | "strong" = current.tier === 0 ? "cheap" : "strong"

        const announce = Stream.succeed(
          value<EscalationEvent>({ _tag: "tier_active", tier: label, model: tier.model }),
        )

        // System prompt is prepended only for the cheap tier and only at
        // request time - it never lives in `state.history`.
        const requestHistory =
          current.tier === 0
            ? [Items.systemText(CHEAP_TIER_SYSTEM_PROMPT), ...current.history]
            : current.history

        const deltas = tier.service
          .streamTurn({
            history: requestHistory,
            model: tier.model,
            ...(current.tier === 0 ? { tools: escalateDescriptors } : {}),
          })
          .pipe(
            onTurnComplete((turn) => {
              if (current.tier === 1) return stop()

              const call = Turn.getToolCalls(turn).find((c) => c.name === "escalate")
              if (call === undefined) return stop()

              // Decode against escalate's own schema - the tool already owns
              // it, so there's no second decoder to keep in sync. Bad arguments
              // log and stop instead of escalating.
              return Tool.decodeArgs(escalate, call).pipe(
                Effect.map((args) =>
                  // Strong tier sees the same accumulated history the cheap tier
                  // saw - no system prompt, no cheap-tier turn, no escalate call.
                  Stream.succeed(value<EscalationEvent>({ _tag: "escalated", ...args })).pipe(
                    Stream.concat(
                      next({ history: current.history, tier: 1, escalation: args } satisfies State),
                    ),
                  ),
                ),
                Effect.catch((error) =>
                  Effect.logError("escalate call had invalid arguments", {
                    call_id: call.call_id,
                    arguments: call.arguments,
                    cause: error.cause,
                  }).pipe(Effect.as(stop())),
                ),
              )
            }),
          )

        return Stream.concat(announce, deltas)
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Convenience: pull the last assistant text out of a collected event log.
// Handy for tests / one-shot runners that just want the final answer.
// ---------------------------------------------------------------------------

export const lastTurn = (events: ReadonlyArray<ConversationEvent>): Option.Option<Turn.Turn> =>
  pipe(
    events,
    Arr.findLast(Turn.isTurnComplete),
    Option.map((e) => e.turn),
  )

export const lastAssistantText = (events: ReadonlyArray<ConversationEvent>): string =>
  pipe(
    lastTurn(events),
    Option.map((turn) => Turn.assistantText(turn)),
    Option.getOrElse(() => ""),
  )
