---
"@effect-uai/core": minor
---

Remove `Approval.fromQueue` (with `Verdict` and `FromQueueOptions`) from core. A verdict queue with a router fiber and a timeout is a pattern, not a primitive; it now lives in the `tool-call-approval` recipe, which you can copy from. See the 0.19 migration page.
