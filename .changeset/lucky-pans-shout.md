---
"@effect-uai/microsandbox": patch
---

Require the `microsandbox` SDK `0.6.x`

The peer range moves from `^0.4.0` to `^0.6.0`. The 0.6 SDK renamed
`SandboxBuilder.replaceWithGrace` to `replaceWithTimeout`, folded
`createDetached()` into the `detached(true)` setter, and made
`Sandbox.list()` paginated. `MicrosandboxSandbox` is ported to all three;
its own request type keeps `replace: { graceMs }` and `list` walks the
cursor, so nothing changes for callers.
