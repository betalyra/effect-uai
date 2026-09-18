/**
 * Triage an inbound support message: route it, prioritise it, and flag what
 * needs a human, in one call.
 *
 * Five heterogeneous questions share one input, so the message is encoded and
 * billed once. Adding a sixth costs a few tokens, not another round trip,
 * which is why speculative questions are worth asking up front and ignoring
 * when they do not apply.
 *
 * Provider-agnostic: the program yields the generic `DecisionModel` tag, so
 * swapping providers is a Layer decision made in `app.ts`.
 */
import { Effect, Schema } from "effect"
import * as Decision from "@effect-uai/core/Decision"
import { decide } from "@effect-uai/core/DecisionModel"

// ---------------------------------------------------------------------------
// The decision set. Declared once: these questions and thresholds are the
// artifact you review, the message changes per call.
// ---------------------------------------------------------------------------

export const Ticket = Schema.Struct({
  subject: Schema.String,
  body: Schema.String,
  plan: Schema.Literals(["free", "pro", "enterprise"]),
})
export type Ticket = typeof Ticket.Type

/**
 * The same schema validates a `--tickets` file and encodes each ticket onto
 * the wire, so a malformed file fails before any request is billed.
 */
export const TicketFile = Schema.fromJsonString(Schema.Array(Ticket))

export const sampleTickets: ReadonlyArray<Ticket> = [
  {
    subject: "Charged twice this morning",
    body: "I see two identical charges on the 3rd. Please refund one, I need this sorted before payroll on Friday.",
    plan: "pro",
  },
  {
    subject: "Export button does nothing",
    body: "Clicking Export on the settings page silently fails in Safari. Works in Chrome. Not blocking me, I can use Chrome.",
    plan: "free",
  },
  {
    subject: "Question",
    body: "Hi, can you help me with my account? My card is 4111 1111 1111 1111 if that matters.",
    plan: "enterprise",
  },
]

export const triage = Decision.make({
  inputSchema: Ticket,
  decisions: {
    department: Decision.classify({
      instructions: "Which team should handle this ticket?",
      criteria: {
        billing: "Charges, invoices, refunds, payment failures",
        technical: "Bugs, outages, integrations, API errors",
        account: "Login, permissions, seats, plan changes",
        other: "Anything the categories above do not cover",
      },
    }),
    severity: Decision.rate({
      instructions: "How severe is the problem for the customer?",
      criteria: [
        "Cosmetic; nothing is blocked",
        "A feature is degraded but a workaround exists",
        "A workflow is blocked with no workaround",
        "Money is being lost right now",
      ],
    }),
    urgent: Decision.probability({
      instructions: "Does the customer say this is time-sensitive?",
      criteria: {
        true: "Names a deadline, or says it is blocking work today",
        false: "No time pressure expressed",
      },
    }),
    refund: Decision.probability({ instructions: "Is the customer asking for a refund?" }),
    // Speculative: only read when the ticket reaches a human.
    personalData: Decision.probability({
      instructions: "Does the message contain personal data such as a card number or address?",
    }),
  },
})

// ---------------------------------------------------------------------------
// Routing. The model reports beliefs; this code makes the decision.
// ---------------------------------------------------------------------------

/**
 * Thresholds are examples. Fit them on your own tickets before trusting them.
 *
 * Both gates read length-stable numbers. Normalized entropy is not one: on a
 * four-label set a decisive 0.74 winner scores only 0.46, so a threshold
 * tuned on two labels silently demands far more mass on four.
 */
const CLEAR = 0.5
const SEPARATED = 0.15
const LIKELY = 0.7

export type Route = Readonly<
  | { readonly kind: "auto"; readonly queue: string; readonly priority: number }
  | { readonly kind: "clarify"; readonly between: ReadonlyArray<string> }
  | { readonly kind: "human"; readonly reason: string }
>

export const route = (answers: Decision.Answers<(typeof triage)["decisions"]>): Route => {
  const { department, severity, urgent, refund } = answers
  const ranked = Decision.ranked(department)
  const leader = ranked[0]

  if (leader === undefined || leader.probability < CLEAR) {
    return { kind: "human", reason: "no clear department" }
  }
  // A close second is a different problem from a flat spread: one more
  // question resolves it, nothing resolves the other.
  if (Decision.margin(department) < SEPARATED) {
    return { kind: "clarify", between: ranked.slice(0, 2).map((outcome) => outcome.label) }
  }
  if (refund.probability > LIKELY) {
    return { kind: "human", reason: "refund requested" }
  }

  const level = Decision.topLevel(severity)
  return {
    kind: "auto",
    queue: leader.label,
    // Urgency nudges priority without being able to invent a level.
    priority: urgent.probability > LIKELY ? Math.min(level + 1, 3) : level,
  }
}

/** Only meaningful once a human is in the loop. */
export const needsRedaction = (answers: Decision.Answers<(typeof triage)["decisions"]>): boolean =>
  answers.personalData.probability > LIKELY

export const triageTicket = (model: string, ticket: Ticket) =>
  Effect.gen(function* () {
    const { answers, usage } = yield* decide(triage, { model, input: ticket })
    return { answers, usage, route: route(answers), redact: needsRedaction(answers) }
  })
