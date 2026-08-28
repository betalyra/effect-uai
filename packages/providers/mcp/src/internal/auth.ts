/**
 * Auth resolution for the HTTP transport. Era-blind: the stateless and
 * handshake protocols both ride an OAuth 2.1 resource server, and neither
 * knows this file exists. Tokens stay `Redacted` until the wire boundary.
 */
import { Data, Effect, Option, Redacted } from "effect"
import type { McpAuthError } from "../McpError.js"

/**
 * An Effect yielding a bearer token. Any external OAuth, vault, or secret
 * manager plugs in here. Read per request, so a producer minting expensive
 * tokens caches internally (as `OAuth.clientCredentials` does).
 */
export type TokenSource = Effect.Effect<Redacted.Redacted<string>, McpAuthError>

export type Auth = Data.TaggedEnum<{
  /** A fixed token: the turnkey case for a token-gated server. */
  Static: { readonly token: Redacted.Redacted<string>; readonly scheme?: string }
  /** Bring your own, re-read before every request. */
  TokenSource: { readonly token: TokenSource; readonly scheme?: string }
  /** Built-in OAuth 2.1, which produces a `TokenSource` and rides the same seam. */
  OAuth: { readonly source: TokenSource; readonly scheme?: string }
}>

export const Auth = Data.taggedEnum<Auth>()

const tokenOf: (auth: Auth) => TokenSource = Auth.$match({
  Static: ({ token }) => Effect.succeed(token),
  TokenSource: ({ token }) => token,
  OAuth: ({ source }) => source,
})

/**
 * The `Authorization` header for one request, or none for a public server.
 * `Redacted.value` is unwrapped only here.
 */
export const authHeaders = (
  auth: Option.Option<Auth>,
): Effect.Effect<Record<string, string>, McpAuthError> =>
  Option.match(auth, {
    onNone: () => Effect.succeed({}),
    onSome: (a) =>
      tokenOf(a).pipe(
        Effect.map((token) => ({
          authorization: `${a.scheme ?? "Bearer"} ${Redacted.value(token)}`,
        })),
      ),
  })
