import { describe, expect, it } from "vitest"
import { type WireUsage, emptyAccumulator, mergeUsage } from "./codec.js"
import { type ProviderEvent, applyEvent } from "./streamEvents.js"

// A completed cached turn: input split across post-breakpoint tokens, cache
// reads, and cache writes, all billed separately.
const wire: WireUsage = {
  input_tokens: 94,
  output_tokens: 210,
  cache_read_input_tokens: 31851,
  cache_creation_input_tokens: 604,
}

describe("mergeUsage", () => {
  it("keeps all three input buckets, not just cache reads", () => {
    const usage = mergeUsage(emptyAccumulator, wire).usage
    expect(usage.input_tokens).toBe(94)
    expect(usage.input_tokens_details?.cached_tokens).toBe(31851)
    expect(usage.input_tokens_details?.cache_write_tokens).toBe(604)
  })

  it("totals every input bucket plus output", () => {
    const usage = mergeUsage(emptyAccumulator, wire).usage
    expect(usage.total_tokens).toBe(94 + 31851 + 604 + 210)
  })
})

describe("streamed usage", () => {
  // Anthropic sends input + cache on message_start and the final output_tokens
  // on message_delta. total_tokens must reflect the accumulated buckets, not
  // the (input + initial output) figure frozen at message_start.
  it("computes a non-stale total across message_start and message_delta", () => {
    const start: ProviderEvent = {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 94,
          output_tokens: 1,
          cache_read_input_tokens: 31851,
          cache_creation_input_tokens: 604,
        },
      },
    }
    const delta: ProviderEvent = {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 210 },
    }
    const usage = applyEvent(applyEvent(emptyAccumulator, start), delta).usage
    expect(usage.output_tokens).toBe(210)
    expect(usage.input_tokens_details?.cache_write_tokens).toBe(604)
    expect(usage.total_tokens).toBe(94 + 31851 + 604 + 210)
  })
})
