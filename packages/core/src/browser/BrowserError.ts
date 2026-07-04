import { Data, Duration, Match } from "effect"

/**
 * Failed to provision a browser session: the transport could not connect,
 * a launched engine did not come up, or the provider refused to mint a
 * session. Provider's structured reason on `reason`; the raw transport /
 * SDK error on `raw`.
 */
export class BrowserCreateFailed extends Data.TaggedError("BrowserCreateFailed")<{
  provider: string
  reason?: string
  raw: unknown
}> {}

/**
 * The requested session id does not exist. Raised by `attach` / `destroy`
 * against a stale or never-known id. Distinct from
 * {@link BrowserSessionExpired}, which is a session that existed and has
 * since ended.
 */
export class BrowserSessionNotFound extends Data.TaggedError("BrowserSessionNotFound")<{
  provider: string
  id: string
}> {}

/**
 * An operation was issued against a session that has ended: it reached its
 * max lifetime (the create-time `timeout`), was destroyed, or the provider
 * reaped it. The handle is dead; `create` or `attach` a live session.
 * Distinct from {@link BrowserTimeout} (a single live operation was too
 * slow).
 */
export class BrowserSessionExpired extends Data.TaggedError("BrowserSessionExpired")<{
  provider: string
  id: string
}> {}

/**
 * A single operation exceeded its own time budget while the session was
 * still alive (a navigation that never settled, a `waitFor` selector that
 * never appeared). Carries the breached budget for observability.
 */
export class BrowserTimeout extends Data.TaggedError("BrowserTimeout")<{
  provider: string
  operation: "create" | "attach" | "navigate" | "action" | "query"
  budget?: Duration.Duration
  raw?: unknown
}> {}

/**
 * An interaction or observation failed at the transport / protocol layer:
 * a selector resolved to nothing, an element was not actionable, an
 * `evaluate` script threw, a navigation errored. `selector` and `reason`
 * carry what is known.
 */
export class BrowserActionFailed extends Data.TaggedError("BrowserActionFailed")<{
  provider: string
  operation: "navigate" | "interact" | "observe" | "evaluate" | "cookies"
  selector?: string
  reason?: string
  raw: unknown
}> {}

/**
 * Provider rejected the request because an account / project quota or
 * concurrency limit was exceeded. Separate from {@link BrowserCreateFailed}
 * so callers can back off and retry.
 */
export class BrowserQuotaExceeded extends Data.TaggedError("BrowserQuotaExceeded")<{
  provider: string
  reason?: string
  raw: unknown
}> {}

/**
 * Caller's request shape is malformed for the wired provider. Adapters
 * should reject at the request-schema layer where possible; this is the
 * runtime fallback.
 */
export class BrowserInvalidRequest extends Data.TaggedError("BrowserInvalidRequest")<{
  provider: string
  param?: string
  reason?: string
  raw?: unknown
}> {}

/**
 * Transport could not authenticate against the provider. Subtype mirrors
 * the model-side `AiError.AuthFailed` shape for consistency.
 */
export type BrowserAuthSubtype = "auth" | "permission" | "billing" | "quota"

export class BrowserAuthFailed extends Data.TaggedError("BrowserAuthFailed")<{
  provider: string
  subtype: BrowserAuthSubtype
  raw: unknown
}> {}

/**
 * The wired provider does not implement the requested operation for these
 * inputs. Distinct from {@link BrowserInvalidRequest} (malformed request)
 * and from compile-time capability markers gating blanket provider gaps.
 */
export class BrowserUnsupported extends Data.TaggedError("BrowserUnsupported")<{
  provider: string
  capability: string
  reason?: string
}> {}

export type BrowserError =
  | BrowserCreateFailed
  | BrowserSessionNotFound
  | BrowserSessionExpired
  | BrowserTimeout
  | BrowserActionFailed
  | BrowserQuotaExceeded
  | BrowserInvalidRequest
  | BrowserAuthFailed
  | BrowserUnsupported

const withReason = (base: string, reason: string | undefined): string =>
  reason === undefined ? base : `${base}: ${reason}`

/**
 * Short human-readable description of an error, for logs and model-facing
 * failure messages. Prose, not a contract; branch on `_tag` instead.
 */
export const describe: (e: BrowserError) => string = Match.type<BrowserError>().pipe(
  Match.discriminatorsExhaustive("_tag")({
    BrowserCreateFailed: (e) => withReason("the browser session could not be created", e.reason),
    BrowserSessionNotFound: () => "the browser session does not exist",
    BrowserSessionExpired: () => "the browser session has expired",
    BrowserTimeout: (e) => `the ${e.operation} operation timed out`,
    BrowserActionFailed: (e) =>
      withReason(
        `the ${e.operation} failed${e.selector === undefined ? "" : ` on ${e.selector}`}`,
        e.reason,
      ),
    BrowserQuotaExceeded: (e) => withReason("the browser quota is exceeded", e.reason),
    BrowserInvalidRequest: (e) => withReason("the request was invalid", e.reason),
    BrowserAuthFailed: (e) => `browser authentication failed (${e.subtype})`,
    BrowserUnsupported: (e) =>
      withReason(`this browser does not support ${e.capability}`, e.reason),
  }),
)
