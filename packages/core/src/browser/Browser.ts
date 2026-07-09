import { Brand, Context, type Duration, Effect, Scope } from "effect"
import type * as BrowserError from "./BrowserError.js"

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Session identifier. Branded `string` so providers don't accidentally
 * accept a raw user-supplied id, and so a session id can't be passed where
 * another service's id is expected. Each provider mints these per its own
 * scheme; core code treats them opaquely. Mint via `BrowserSessionId(...)`.
 */
export type BrowserSessionId = Brand.Branded<string, "BrowserSessionId">
export const BrowserSessionId = Brand.nominal<BrowserSessionId>()

/** Reference returned by `list`; enough to `attach`. */
export type BrowserSessionRef = {
  readonly id: BrowserSessionId
  /** Current top-level URL, when the provider reports it. */
  readonly url?: string
}

/**
 * Output representation for {@link BrowserSession.content}. `markdown` is
 * the default.
 */
export type PageFormat = "markdown" | "html"

// ---------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------

/**
 * Cross-provider session-create request. Provider-specific knobs (proxy,
 * stealth, persistent profile, ...) live on each provider's narrowed
 * request type which extends this.
 */
export type CommonSessionRequest = {
  /**
   * Hard max lifetime of the session. Enforced locally (the handle is
   * disposed and further calls fail with `BrowserSessionExpired`) and,
   * where the provider supports it, passed through as a server-side cap so
   * a crashed client still gets the session reclaimed. The provider cap
   * must be >= the local reaper. Accepts millis, a string like
   * `"5 minutes"`, or a `Duration`.
   */
  readonly timeout?: Duration.Input
  /**
   * Idle teardown: dispose the session after this much inactivity, the
   * timer resetting on each operation. Opt-in; omit for no idle limit.
   */
  readonly idleTimeout?: Duration.Input
  /** Initial viewport size. Providers default differently. */
  readonly viewport?: { readonly width: number; readonly height: number }
}

// ---------------------------------------------------------------------------
// Observation shapes
// ---------------------------------------------------------------------------

export type BoundingBox = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * One element returned by {@link BrowserSession.query}. Serializable data,
 * not a live handle (handles go stale across navigation and do not cross a
 * provider boundary cleanly).
 */
export type ElementInfo = {
  /**
   * Reference usable as a selector for a follow-up action. Valid until the
   * next navigation; do not cache across `goto` or a page-changing click.
   */
  readonly ref: string
  readonly tag: string
  readonly text?: string
  readonly attributes: Readonly<Record<string, string>>
  readonly box?: BoundingBox
}

/** Accessibility-tree node returned by {@link BrowserSession.snapshot}. */
export type AxNode = {
  readonly role: string
  readonly name?: string
  readonly value?: string
  /**
   * Reference usable as a selector for a follow-up action. Valid until the
   * next navigation; do not cache across `goto` or a page-changing click.
   */
  readonly ref?: string
  readonly children: ReadonlyArray<AxNode>
}

// ---------------------------------------------------------------------------
// Interaction shapes
// ---------------------------------------------------------------------------

export type ScrollDirection = "up" | "down" | "left" | "right"

export type ScrollOptions = {
  readonly direction: ScrollDirection
  /** Distance in CSS pixels. Provider default applies when omitted. */
  readonly pixels?: number
}

export type ScreenshotOptions = {
  /** Clip to the first element matching this selector. */
  readonly selector?: string
  /** Capture the full scrollable page rather than the viewport. */
  readonly fullPage?: boolean
}

export type Cookie = {
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path?: string
  readonly expires?: number
  readonly httpOnly?: boolean
  readonly secure?: boolean
  readonly sameSite?: "Strict" | "Lax" | "None"
}

/** Read / write the session's cookie jar. Needed for authenticated flows. */
export type CookieApi = {
  readonly get: Effect.Effect<ReadonlyArray<Cookie>, BrowserError.BrowserError>
  readonly set: (cookies: ReadonlyArray<Cookie>) => Effect.Effect<void, BrowserError.BrowserError>
}

// ---------------------------------------------------------------------------
// Live session handle
// ---------------------------------------------------------------------------

/**
 * Live session handle. Actions take a CSS selector string (so `#id` is
 * just `#id`). Methods are plain `Effect` values; disposal is the scope
 * finalizer, not a method here (see {@link BrowserService}). Anything not
 * covered by a verb is reachable via `evaluate`. Per-operation time budgets
 * are the provider's default; wrap any call in `Effect.timeout` for a
 * tighter bound.
 */
export type BrowserSession = {
  readonly id: BrowserSessionId

  // Navigation and waiting
  readonly goto: (url: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly waitFor: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>

  // Interaction
  readonly click: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly dblclick: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly fill: (selector: string, text: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly type: (selector: string, text: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly press: (key: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly hover: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly focus: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly select: (
    selector: string,
    value: string,
  ) => Effect.Effect<void, BrowserError.BrowserError>
  readonly check: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly uncheck: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>
  readonly scroll: (options: ScrollOptions) => Effect.Effect<void, BrowserError.BrowserError>
  readonly scrollIntoView: (selector: string) => Effect.Effect<void, BrowserError.BrowserError>

  // Observation
  readonly content: (format?: PageFormat) => Effect.Effect<string, BrowserError.BrowserError>
  readonly screenshot: (
    options?: ScreenshotOptions,
  ) => Effect.Effect<Uint8Array, BrowserError.BrowserError>
  readonly snapshot: Effect.Effect<AxNode, BrowserError.BrowserError>
  readonly query: (
    selector: string,
  ) => Effect.Effect<ReadonlyArray<ElementInfo>, BrowserError.BrowserError>

  // State and escape hatch
  readonly cookies: CookieApi
  readonly evaluate: (script: string) => Effect.Effect<unknown, BrowserError.BrowserError>
}

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

/**
 * Cross-provider browser service.
 *
 * Lifetime: `create` and `attach` return a handle in `Scope.Scope`. The
 * scope finalizer disposes the session (close the transport, destroy or
 * detach the remote session, kill the local engine). Bind with
 * `Effect.scoped` for a single call, or hold a wider scope to keep a
 * session warm across many calls. This is why there is no `dispose()` on
 * {@link BrowserSession}; the scope is the lifecycle handle.
 */
export type BrowserService = {
  /**
   * Provision a new session, bound to the caller's scope. Disposed on
   * scope close.
   */
  readonly create: (
    request: CommonSessionRequest,
  ) => Effect.Effect<BrowserSession, BrowserError.BrowserError, Scope.Scope>

  /**
   * Re-acquire an existing session by id. Scope-bound, but the finalizer
   * detaches rather than destroying, for sessions kept warm beyond a
   * single run.
   */
  readonly attach: (
    id: BrowserSessionId,
  ) => Effect.Effect<BrowserSession, BrowserError.BrowserError, Scope.Scope>

  /** Enumerate sessions visible to the configured account / project. */
  readonly list: Effect.Effect<ReadonlyArray<BrowserSessionRef>, BrowserError.BrowserError>

  /**
   * Destroy a session from outside its owning scope. Most callers should
   * let the scope finalizer handle this.
   */
  readonly destroy: (id: BrowserSessionId) => Effect.Effect<void, BrowserError.BrowserError>
}

export class Browser extends Context.Service<Browser, BrowserService>()(
  "@betalyra/effect-uai/Browser",
) {}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/**
 * Provision a session bound to the caller's scope. Drop the `Scope.Scope`
 * requirement with `Effect.scoped`.
 */
export const create = (
  request: CommonSessionRequest,
): Effect.Effect<BrowserSession, BrowserError.BrowserError, Browser | Scope.Scope> =>
  Effect.flatMap(Browser, (s) => s.create(request))

/**
 * Re-acquire an existing session by id. Same scope semantics as `create`,
 * but the finalizer detaches rather than destroying.
 */
export const attach = (
  id: BrowserSessionId,
): Effect.Effect<BrowserSession, BrowserError.BrowserError, Browser | Scope.Scope> =>
  Effect.flatMap(Browser, (s) => s.attach(id))

/** Enumerate sessions for the configured account / project. */
export const list: Effect.Effect<
  ReadonlyArray<BrowserSessionRef>,
  BrowserError.BrowserError,
  Browser
> = Effect.flatMap(Browser, (s) => s.list)

/**
 * Destroy a session from outside its owning scope. Most callers should let
 * the scope finalizer handle this automatically.
 */
export const destroy = (
  id: BrowserSessionId,
): Effect.Effect<void, BrowserError.BrowserError, Browser> =>
  Effect.flatMap(Browser, (s) => s.destroy(id))
