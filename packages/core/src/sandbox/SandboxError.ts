import { Data, Duration } from "effect"

/**
 * Failed to provision a sandbox. Covers image pull failures, region
 * unavailability, the provider being unreachable, etc. The provider's
 * structured reason (if any) is on `reason`; the raw error from the
 * underlying SDK is on `raw`.
 */
export class SandboxCreateFailed extends Data.TaggedError("SandboxCreateFailed")<{
  provider: string
  reason?: string
  raw: unknown
}> {}

/**
 * The requested sandbox id does not exist (or was already destroyed).
 * Distinct from `SandboxCreateFailed` — this is for `attach` / `destroy` /
 * `get`-style lookups against a stale id.
 */
export class SandboxNotFound extends Data.TaggedError("SandboxNotFound")<{
  provider: string
  id: string
}> {}

/**
 * Caller tried to create a sandbox whose id is already taken. Providers
 * that keyed by name (Microsandbox, Modal) surface this when a previous
 * sandbox with the same name is still alive. Distinct from
 * `SandboxCreateFailed` so callers can retry with `replace` semantics.
 */
export class SandboxAlreadyExists extends Data.TaggedError("SandboxAlreadyExists")<{
  provider: string
  id: string
}> {}

/**
 * A shell exec inside the sandbox failed at the transport / SDK layer —
 * i.e. the SDK couldn't deliver the command to the guest, or the guest
 * agent itself errored. A non-zero exit code from the guest's command
 * is NOT an error; it's an `ExecResult` with `exitCode !== 0`.
 */
export class SandboxExecFailed extends Data.TaggedError("SandboxExecFailed")<{
  provider: string
  reason?: string
  raw: unknown
}> {}

/**
 * A sandbox operation (create, exec, file op) exceeded its time budget.
 * Carries the budget that was breached for observability.
 */
export class SandboxTimeout extends Data.TaggedError("SandboxTimeout")<{
  provider: string
  operation: "create" | "exec" | "filesystem" | "attach"
  budget?: Duration.Duration
  raw?: unknown
}> {}

/**
 * Outbound network request from inside the sandbox was blocked by the
 * configured egress policy (host not on allowlist, CIDR mismatch, etc.).
 * Surfaced when the provider's SDK reports the denial back to the host
 * — many providers simply let the request fail inside the guest and
 * never report this to the host, in which case this error is never
 * raised by the adapter.
 */
export class SandboxNetworkPolicyDenied extends Data.TaggedError("SandboxNetworkPolicyDenied")<{
  provider: string
  host?: string
  reason?: string
  raw: unknown
}> {}

/**
 * Provider rejected the create / exec because account / org / project
 * quota or concurrency limit was exceeded. Surfaced separately from
 * `SandboxCreateFailed` so callers can back off and retry intelligently.
 */
export class SandboxQuotaExceeded extends Data.TaggedError("SandboxQuotaExceeded")<{
  provider: string
  reason?: string
  raw: unknown
}> {}

/**
 * Caller's request shape is malformed for the wired provider — e.g. a
 * Dockerfile passed to a provider that only accepts registry refs, a
 * hostname allowlist passed to a CIDR-only provider, etc. Adapters
 * should also reject these at the request-schema layer where possible;
 * this is the runtime fallback.
 */
export class SandboxInvalidRequest extends Data.TaggedError("SandboxInvalidRequest")<{
  provider: string
  param?: string
  reason?: string
  raw?: unknown
}> {}

/**
 * Sandbox SDK could not authenticate against the provider. Subtype
 * mirrors the model-side `AiError.AuthFailed` shape for consistency.
 */
export type SandboxAuthSubtype = "auth" | "permission" | "billing" | "quota"

export class SandboxAuthFailed extends Data.TaggedError("SandboxAuthFailed")<{
  provider: string
  subtype: SandboxAuthSubtype
  raw: unknown
}> {}

/**
 * The wired provider does not implement the requested capability for
 * this specific request. Distinct from `SandboxInvalidRequest` (the
 * request shape is malformed) and from compile-time capability
 * markers (`SandboxSnapshots`, `SandboxSecretInjection`, …) which gate
 * blanket provider-level gaps.
 *
 * Reserved for request-data-dependent gaps where the provider supports
 * the method in general but not for these inputs — e.g. passing
 * `hosts: [...]` to a CIDR-only allowlist provider, or passing
 * `dockerfile: ...` to a provider whose `SandboxCustomImage` marker
 * was provided but which only accepts a flat Dockerfile string.
 */
export class SandboxUnsupported extends Data.TaggedError("SandboxUnsupported")<{
  provider: string
  capability: string
  reason?: string
}> {}

export type SandboxError =
  | SandboxCreateFailed
  | SandboxNotFound
  | SandboxAlreadyExists
  | SandboxExecFailed
  | SandboxTimeout
  | SandboxNetworkPolicyDenied
  | SandboxQuotaExceeded
  | SandboxInvalidRequest
  | SandboxAuthFailed
  | SandboxUnsupported
