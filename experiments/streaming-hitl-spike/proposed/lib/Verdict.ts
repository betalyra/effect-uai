/**
 * Library: the approval verdict carried on the recipe's verdict queue.
 * One verdict per gated `call_id`. Unknown call_ids are ignored by the
 * router; duplicates for the same call_id resolve only the first time.
 */

export interface Verdict {
  readonly call_id: string
  readonly decision: "approve" | "deny"
  readonly reason?: string
}
