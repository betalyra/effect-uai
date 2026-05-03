/**
 * Application code: three demo tools covering the matrix.
 *
 *   - `web_search`      : streaming, no approval
 *   - `bulk_email`      : streaming, requires approval
 *   - `delete_database` : non-streaming, requires approval
 *
 * The recipe author writes these like any Tool/StreamingTool. Approval
 * gating is decided at execution time by the predicate in `approval.ts`,
 * not on the tool itself.
 */
import { Effect, Schema, Stream } from "effect"
import * as Tool from "@effect-uai/core/Tool"
import { type AnyKindTool, streaming } from "../lib/index.js"

// --- a: streaming, no approval -----------------------------------------

export interface SearchHit {
  readonly url: string
  readonly title: string
}

const WebSearchInput = Schema.Struct({ query: Schema.String })

export const webSearch = streaming({
  name: "web_search",
  description: "Search the web, streaming hits as they arrive.",
  inputSchema: Tool.fromEffectSchema(WebSearchInput),
  run: ({ query }) =>
    Stream.fromIterable<SearchHit>([
      { url: "https://a.example", title: `${query} - first hit` },
      { url: "https://b.example", title: `${query} - second hit` },
      { url: "https://c.example", title: `${query} - third hit` },
    ]),
  finalize: (hits) => ({ count: hits.length, hits }),
  strict: true,
})

// --- b: streaming, requires approval ------------------------------------

export type BulkEmailEvent =
  | { readonly type: "progress"; readonly sent: number; readonly total: number }
  | { readonly type: "done"; readonly delivered: number }

const BulkEmailInput = Schema.Struct({
  recipients: Schema.Array(Schema.String),
  subject: Schema.String,
})

export const bulkEmail = streaming({
  name: "bulk_email",
  description: "Send the same email to many recipients, streaming progress.",
  inputSchema: Tool.fromEffectSchema(BulkEmailInput),
  run: ({ recipients }) => {
    const total = recipients.length
    return Stream.fromIterable<BulkEmailEvent>([
      ...recipients.map(
        (_, i): BulkEmailEvent => ({ type: "progress", sent: i + 1, total }),
      ),
      { type: "done", delivered: total },
    ])
  },
  finalize: (events): { status: "sent" | "failed"; delivered: number } => {
    const done = events.find((e) => e.type === "done")
    return done
      ? { status: "sent", delivered: done.delivered }
      : { status: "failed", delivered: 0 }
  },
  strict: true,
})

// --- c: non-streaming, requires approval --------------------------------

const DeleteDatabaseInput = Schema.Struct({ name: Schema.String })

export const deleteDatabase = Tool.make({
  name: "delete_database",
  description: "Permanently drop a database.",
  inputSchema: Tool.fromEffectSchema(DeleteDatabaseInput),
  run: ({ name }) => Effect.succeed({ status: "dropped", name }),
  strict: true,
})

export const allTools: ReadonlyArray<AnyKindTool> = [webSearch, bulkEmail, deleteDatabase]
