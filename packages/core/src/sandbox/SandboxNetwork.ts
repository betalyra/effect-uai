import { NetworkPolicy } from "./Sandbox.js"

/**
 * Ergonomic constructors for {@link NetworkPolicy}. The tagged
 * constructors under `Sandbox.NetworkPolicy.*` still exist (and are
 * what pattern-matching code uses); these helpers are what end users
 * reach for at the call site.
 *
 * @example
 * ```ts
 * import * as Network from "@effect-uai/core/SandboxNetwork"
 *
 * Network.open                                    // provider defaults apply
 * Network.blocked                                 // airgapped — no egress
 * Network.allowHosts("api.openai.com", "github.com")
 * Network.allowCidrs("10.0.0.0/8")
 * Network.allow({ hosts: [...], cidrs: [...] })   // combined allowlist
 * ```
 */

export const open: NetworkPolicy = NetworkPolicy.Open()

export const blocked: NetworkPolicy = NetworkPolicy.Blocked()

export const allowHosts = (...hosts: ReadonlyArray<string>): NetworkPolicy =>
  NetworkPolicy.Allowlist({ hosts })

export const allowCidrs = (...cidrs: ReadonlyArray<string>): NetworkPolicy =>
  NetworkPolicy.Allowlist({ cidrs })

export const allow = (opts: {
  readonly hosts?: ReadonlyArray<string>
  readonly cidrs?: ReadonlyArray<string>
}): NetworkPolicy => NetworkPolicy.Allowlist(opts)
