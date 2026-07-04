import { Effect, Result, Schema } from "effect"
import * as AiError from "../domain/AiError.js"
import * as Tool from "../tool/Tool.js"
import { read, type ReadFormat, type ReadResponse, WebRead } from "./WebRead.js"

/**
 * Model-facing argument schema. Deliberately narrow: the URL is the only
 * thing that is genuinely the model's call. Output format and the content
 * cost ceiling are app policy, pinned on the constructor instead, so they
 * are guaranteed rather than left to the model to remember each call.
 */
const WebReadToolArgs = Schema.Struct({
  url: Schema.String.annotate({
    description: "Absolute URL of the page to read.",
  }),
})

export type WebReadToolArgs = typeof WebReadToolArgs.Type

/** Operator problems stay on the error channel; the model cannot fix a key. */
const isModelActionable = (e: AiError.AiError): e is Exclude<AiError.AiError, AiError.AuthFailed> =>
  e._tag !== "AuthFailed"

/** `title / url` header plus the extracted content - what a model reads best. */
const defaultRender = (response: ReadResponse, maxChars: number): string => {
  const header = response.title === undefined ? response.url : `${response.title}\n${response.url}`
  const body =
    response.content.length > maxChars
      ? `${response.content.slice(0, maxChars)}\n[content truncated at ${maxChars} characters]`
      : response.content
  return `${header}\n\n${body}`
}

export type WebReadToolOptions = {
  /** Tool name the model sees. Default `"web_read"`. */
  readonly name?: string
  /**
   * App-fixed representation for every read - a policy choice, not a model
   * knob. Default `"markdown"` (what models read best).
   */
  readonly format?: ReadFormat
  /**
   * App-fixed ceiling on rendered content characters per call - a context
   * cost guard, not exposed to the model. Default `20000`.
   */
  readonly maxChars?: number
  /**
   * Override how a read response is rendered into the model-facing string.
   * Default: `title / url` header plus the content, truncated at `maxChars`.
   */
  readonly render?: (response: ReadResponse) => string
}

/**
 * The canonical web-read tool. Its `R` is just `WebRead`, so providing any
 * read-provider Layer satisfies it and the model-facing contract (name,
 * description, schema) is identical no matter which backend answers - swap
 * `FirecrawlRead.layer` for `JinaRead.layer` and the tool the model sees
 * does not change. Drops straight into a `Toolkit` next to `webSearchTool`
 * (search finds the URLs, read fetches the ones worth reading in full).
 *
 * `Output` is `Result<string, string>`: the rendered page on success, and a
 * model-readable failure message when the page could not be read - for an
 * agent, an unreadable page is signal to try another source. Auth failures
 * stay on the error channel; they are the operator's problem.
 *
 * This is a simple default implementation for quick use. For more elaborate
 * cases (a different output contract, more model-facing knobs), build your
 * own tool with `Tool.make` over the same `read` helper.
 */
export const webReadTool = (
  options?: WebReadToolOptions,
): Tool.Tool<string, WebReadToolArgs, never, Result.Result<string, string>, WebRead> => {
  const name = options?.name ?? "web_read"
  const format = options?.format ?? "markdown"
  const maxChars = options?.maxChars ?? 20_000
  const render = options?.render ?? ((response: ReadResponse) => defaultRender(response, maxChars))
  return Tool.make({
    name,
    description:
      "Read a web page and return its content as clean text. Use it to read a promising URL in full (e.g. one found via search).",
    inputSchema: Tool.fromEffectSchema(WebReadToolArgs),
    // The call is wrapped in a tracing span so agent traces show the tool
    // invocation (url, format, content length) nested under the model turn.
    // `withSpan` is a no-op until a Tracer is installed, so this is free by
    // default and adds nothing to the requirements.
    run: (args) =>
      read({ url: args.url, format }).pipe(
        Effect.tap((r) => Effect.annotateCurrentSpan("web_read.content_chars", r.content.length)),
        Effect.map((r) => Result.succeed(render(r))),
        Effect.catchIf(isModelActionable, (e) => Effect.succeed(Result.fail(AiError.describe(e)))),
        Effect.withSpan(name, {
          kind: "client",
          attributes: {
            "web_read.url": args.url,
            "web_read.format": format,
            "web_read.max_chars": maxChars,
          },
        }),
      ),
  })
}
