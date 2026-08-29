/**
 * The core `Tokenizer` tag over `@huggingface/tokenizers`, which reads a
 * model's `tokenizer.json` and needs no native build. The package is an
 * optional peer dependency: `pnpm add @huggingface/tokenizers`.
 *
 * Fetching and construction are separate on purpose. `download` gives you
 * plain JSON to keep wherever your application keeps things; `fromDefinition`
 * builds the tokenizer from what you kept. Nothing here touches the filesystem
 * or caches behind your back. `layer` composes the two for scripts happy to
 * download on every run.
 */
import { Array as Arr, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Tokenizer, type TokenizerService } from "@effect-uai/core/Tokenizer"
import { Tokenizer as HfTokenizer } from "@huggingface/tokenizers"

/** The vocabulary could not be fetched, parsed, or loaded. */
export class TokenizerLoadError extends Schema.TaggedError<TokenizerLoadError>(
  "@effect-uai/retrieval/TokenizerLoadError",
)("TokenizerLoadError", {
  model: Schema.optional(Schema.String),
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Everything that defines a tokenizer's behaviour, as published. Plain JSON:
 * write it to disk, a row, or your bundle, and decode it back with this schema.
 */
export const Definition = Schema.Struct({
  /** Contents of `tokenizer.json`. */
  tokenizer: Schema.Unknown,
  /** Contents of `tokenizer_config.json`, absent for repos that publish none. */
  config: Schema.optional(Schema.Unknown),
})

export type Definition = typeof Definition.Type

export type Options = {
  /** A Hugging Face repo id, e.g. `"jinaai/jina-embeddings-v3"` or `"Xenova/gpt-4o"`. */
  readonly model: string
  /** Branch, tag, or commit. Default `"main"`. */
  readonly revision?: string
  /**
   * A Hugging Face access token. Required for gated repos, where the Hub
   * serves the files only to accounts that have accepted the model's terms
   * (Google's tokenizers among them), and for private ones.
   */
  readonly token?: Redacted.Redacted
}

const fetchJson = (
  options: Options,
  file: string,
): Effect.Effect<unknown, TokenizerLoadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const url = `https://huggingface.co/${options.model}/resolve/${options.revision ?? "main"}/${file}`
    const failed = (reason: string) => (cause: unknown) =>
      new TokenizerLoadError({ model: options.model, reason, cause })

    const request = HttpClientRequest.get(url).pipe(
      options.token === undefined
        ? (self) => self
        : HttpClientRequest.bearerToken(Redacted.value(options.token)),
    )
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(failed(`could not fetch ${file}`)))
    // 401/403 on a gated repo means no token, or terms not yet accepted.
    return response.status >= 400
      ? yield* new TokenizerLoadError({
          model: options.model,
          reason: `${url} returned ${response.status}`,
        })
      : yield* response.json.pipe(Effect.mapError(failed(`${file} is not valid JSON`)))
  })

/**
 * Fetch a model's definition from the Hugging Face Hub. Cache the result
 * yourself; a repo without a `tokenizer_config.json` yields `config: undefined`.
 */
export const download = (
  options: Options,
): Effect.Effect<Definition, TokenizerLoadError, HttpClient.HttpClient> =>
  Effect.all({
    tokenizer: fetchJson(options, "tokenizer.json"),
    config: fetchJson(options, "tokenizer_config.json").pipe(Effect.orElseSucceed(() => undefined)),
  })

/** Build the tokenizer from a definition you already hold. No IO. */
export const fromDefinition = (
  definition: Definition,
): Layer.Layer<Tokenizer, TokenizerLoadError> =>
  Layer.effect(
    Tokenizer,
    Effect.try({
      try: (): TokenizerService => {
        const hf = new HfTokenizer(
          definition.tokenizer as object,
          (definition.config ?? {}) as object,
        )
        return {
          encode: (text) => hf.encode(text).ids,
          // The library mutates nothing, but its signature wants a mutable array.
          decode: (tokens) => hf.decode(Arr.copy(tokens)),
        }
      },
      catch: (cause) => new TokenizerLoadError({ reason: "could not load the tokenizer", cause }),
    }),
  )

/** Download and build in one step. For scripts; production should cache. */
export const layer = (
  options: Options,
): Layer.Layer<Tokenizer, TokenizerLoadError, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(download(options), fromDefinition))
