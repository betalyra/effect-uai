import { Data, type Duration, Match } from "effect"

// `reason` is required wherever one exists: the platform always says
// something, and an adapter raising `Unsupported` knows why it did.

/** Transport never came up: bad token, rejected handshake. Raised at layer build. */
export class MessengerConnectFailed extends Data.TaggedError("MessengerConnectFailed")<{
  provider: string
  reason: string
  raw: unknown
}> {}

/**
 * Inbound transport ended for good (reconnect budget spent, fatal close).
 * Routine reconnects stay inside the adapter and never surface here.
 */
export class MessengerTransportClosed extends Data.TaggedError("MessengerTransportClosed")<{
  provider: string
  reason: string
  raw?: unknown
}> {}

/** Which verb was rejected. */
export type MessengerOperation = "post" | "edit" | "react" | "typing"

/** An outbound verb was rejected: permission, unknown chat, text too long, no-op edit. */
export class MessengerRequestFailed extends Data.TaggedError("MessengerRequestFailed")<{
  provider: string
  operation: MessengerOperation
  reason: string
  raw: unknown
}> {}

/**
 * Slow down, for this long. Typed rather than retried blindly so callers -
 * `streamViaEdits` above all - decide whether waiting is still worth it.
 */
export class MessengerRateLimited extends Data.TaggedError("MessengerRateLimited")<{
  provider: string
  retryAfter: Duration.Duration
  raw?: unknown
}> {}

/** The platform cannot express this at all: off-set reaction emoji, edits on WhatsApp. */
export class MessengerUnsupported extends Data.TaggedError("MessengerUnsupported")<{
  provider: string
  capability: string
  reason: string
}> {}

export type MessengerError =
  | MessengerConnectFailed
  | MessengerTransportClosed
  | MessengerRequestFailed
  | MessengerRateLimited
  | MessengerUnsupported

/** Human-readable description for logs. Prose, not a contract; branch on `_tag`. */
export const describe: (e: MessengerError) => string = Match.type<MessengerError>().pipe(
  Match.discriminatorsExhaustive("_tag")({
    MessengerConnectFailed: (e) => `the messenger could not connect: ${e.reason}`,
    MessengerTransportClosed: (e) => `the messenger connection closed: ${e.reason}`,
    MessengerRequestFailed: (e) => `the ${e.operation} was rejected: ${e.reason}`,
    MessengerRateLimited: () => "the messenger is rate limited",
    MessengerUnsupported: (e) => `this messenger does not support ${e.capability}: ${e.reason}`,
  }),
)
