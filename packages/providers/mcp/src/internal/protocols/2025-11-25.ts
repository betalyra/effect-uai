/**
 * Protocol revision 2025-11-25. Wire-compatible with 2025-06-18 for a
 * tools-only client: its additions (icons, tasks, OIDC discovery) do not touch
 * `initialize`, `tools/list` or `tools/call`, so it re-exports that
 * implementation rather than duplicating it. If a future delta does affect our
 * subset, it belongs here.
 */
export { probe } from "./2025-06-18.js"
