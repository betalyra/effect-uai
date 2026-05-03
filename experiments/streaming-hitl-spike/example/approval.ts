/**
 * Application code: which tools require human approval. The predicate is
 * passed to `executeWithApproval` per turn; the recipe owns this policy
 * (no tool-side annotation).
 */
import type * as Items from "@effect-uai/core/Items"

const SENSITIVE: ReadonlySet<string> = new Set(["bulk_email", "delete_database"])

export const isSensitive = (call: Items.FunctionCall): boolean => SENSITIVE.has(call.name)
