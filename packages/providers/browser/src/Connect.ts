/**
 * Generic CDP connect provider.
 *
 * Point it at any browser-level CDP WebSocket endpoint and it registers
 * the core `Browser` capability over it. This is the shared floor for the
 * whole field: a locally launched Chromium (`--remote-debugging-port`),
 * obscura's partial CDP server, or a hosted vendor's `wss://` connect URL
 * pasted straight in. Vendor-specific packages (session-create REST call,
 * auth handshake) can layer on top and reuse this data plane.
 *
 * Sessions map to CDP targets: `create` opens a fresh target (tab),
 * `attach` re-attaches to an existing one by target id (finalizer detaches
 * without closing, for warm reuse), `destroy` closes the target from
 * anywhere. The `timeout` / `idleTimeout` knobs on the create request are
 * enforced locally by the session's reaper fibers; a plain CDP endpoint
 * has no server-side cap to mirror them to.
 */
import * as CoreBrowser from "@effect-uai/core/Browser"
import * as BrowserError from "@effect-uai/core/BrowserError"
import { Context, Effect, Layer } from "effect"
import { type Cdp, type CdpError, openCdp } from "./internal/cdp.js"
import { isMethodMissing, makeSession } from "./internal/session.js"

const PROVIDER = "cdp"

export type CdpConnectConfig = {
  /**
   * Browser-level CDP WebSocket endpoint, e.g.
   * `ws://127.0.0.1:9222/devtools/browser/<uuid>` for local Chromium or
   * obscura, or a hosted provider's connect URL (credentials in the URL).
   */
  readonly endpoint: string
}

/**
 * Provider tag. Identical surface to the core `Browser` service; both tags
 * are registered by {@link layer}.
 */
export class CdpBrowser extends Context.Service<CdpBrowser, CoreBrowser.BrowserService>()(
  "@betalyra/effect-uai/providers/browser/CdpBrowser",
) {}

// ---------------------------------------------------------------------------
// Error mapping (control-plane operations; the session maps its own).
// ---------------------------------------------------------------------------

const mapCreate = (e: CdpError): BrowserError.BrowserError =>
  new BrowserError.BrowserCreateFailed({
    provider: PROVIDER,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
    raw: e,
  })

const mapLookup =
  (id: string) =>
  (e: CdpError): BrowserError.BrowserError =>
    e.kind === "reply" && /no target|not found|invalid target|no session/i.test(e.reason ?? "")
      ? new BrowserError.BrowserSessionNotFound({ provider: PROVIDER, id })
      : mapCreate(e)

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Enable the domains the session verbs rely on. Partial CDP servers that
 * auto-enable (or don't know an `enable` method) are tolerated: a
 * method-missing reply is not an error.
 */
const enableDomains = (cdp: Cdp, sessionId: string) =>
  Effect.forEach(["Page.enable", "Runtime.enable", "Network.enable"] as const, (method) =>
    cdp.send(method, {}, sessionId).pipe(Effect.catchIf(isMethodMissing, () => Effect.succeed({}))),
  ).pipe(Effect.asVoid, Effect.mapError(mapCreate))

const applyViewport = (
  cdp: Cdp,
  sessionId: string,
  viewport: NonNullable<CoreBrowser.CommonSessionRequest["viewport"]>,
) =>
  cdp
    .send(
      "Emulation.setDeviceMetricsOverride",
      { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    .pipe(
      // No Emulation domain: the engine's default viewport stands.
      Effect.catchIf(isMethodMissing, () => Effect.succeed({})),
      Effect.asVoid,
      Effect.mapError(mapCreate),
    )

const makeService = (config: CdpConnectConfig): CoreBrowser.BrowserService => ({
  create: (request) =>
    Effect.gen(function* () {
      const cdp = yield* openCdp(config.endpoint)
      const { targetId } = yield* cdp
        .send("Target.createTarget", { url: "about:blank" })
        .pipe(Effect.mapError(mapCreate))
      const closeTarget = cdp.send("Target.closeTarget", { targetId }).pipe(Effect.ignore)
      yield* Effect.addFinalizer(() => closeTarget)
      const { sessionId } = yield* cdp
        .send("Target.attachToTarget", { targetId, flatten: true })
        .pipe(Effect.mapError(mapCreate))
      yield* enableDomains(cdp, sessionId)
      if (request.viewport !== undefined) {
        yield* applyViewport(cdp, sessionId, request.viewport)
      }
      return yield* makeSession({
        cdp,
        id: CoreBrowser.BrowserSessionId(targetId),
        sessionId,
        provider: PROVIDER,
        request,
        dispose: closeTarget,
      })
    }),

  attach: (id) =>
    Effect.gen(function* () {
      const cdp = yield* openCdp(config.endpoint)
      const { sessionId } = yield* cdp
        .send("Target.attachToTarget", { targetId: id, flatten: true })
        .pipe(Effect.mapError(mapLookup(id)))
      // Detach on scope close; the target keeps running for warm reuse.
      yield* Effect.addFinalizer(() =>
        cdp.send("Target.detachFromTarget", { sessionId }).pipe(Effect.ignore),
      )
      yield* enableDomains(cdp, sessionId)
      return yield* makeSession({
        cdp,
        id,
        sessionId,
        provider: PROVIDER,
        request: {},
        dispose: Effect.void,
      })
    }),

  list: Effect.scoped(
    Effect.gen(function* () {
      const cdp = yield* openCdp(config.endpoint)
      const { targetInfos } = yield* cdp.send("Target.getTargets").pipe(Effect.mapError(mapCreate))
      return targetInfos
        .filter((target) => target.type === "page")
        .map((target): CoreBrowser.BrowserSessionRef => ({
          id: CoreBrowser.BrowserSessionId(target.targetId),
          ...(target.url !== "" ? { url: target.url } : {}),
        }))
    }),
  ),

  destroy: (id) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cdp = yield* openCdp(config.endpoint)
        yield* cdp.send("Target.closeTarget", { targetId: id }).pipe(Effect.mapError(mapLookup(id)))
      }),
    ),
})

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Registers the generic CDP adapter against both the provider tag
 * ({@link CdpBrowser}) and the core `Browser` tag. No capability markers:
 * proxy / stealth / recording are vendor features, not part of a bare CDP
 * endpoint.
 */
export const layer = (config: CdpConnectConfig): Layer.Layer<CdpBrowser | CoreBrowser.Browser> => {
  const service = makeService(config)
  return Layer.mergeAll(
    Layer.succeed(CdpBrowser, service),
    Layer.succeed(CoreBrowser.Browser, service),
  )
}
