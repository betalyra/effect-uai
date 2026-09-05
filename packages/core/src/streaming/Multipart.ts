import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"

/**
 * Multipart body for an `HttpClientRequest`, encoded to bytes.
 *
 * Use this over `HttpClientRequest.bodyFormData`: the Undici client
 * passes the `FormData` object straight to `dispatcher.request`, which
 * cannot serialise it, so the request is never sent and the effect
 * hangs with no error. Encoding here produces the same bytes every
 * other client derives internally, so it works on all of them.
 *
 * The failure is whatever `Response.arrayBuffer` rejects with; map it
 * to your provider's transport error at the call site.
 */
export const bodyMultipart = (
  form: FormData,
): Effect.Effect<
  (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  unknown
> =>
  Effect.gen(function* () {
    const encoded = new Response(form)
    const buffer = yield* Effect.tryPromise(() => encoded.arrayBuffer())
    return HttpClientRequest.bodyUint8Array(
      new Uint8Array(buffer),
      encoded.headers.get("content-type") ?? "multipart/form-data",
    )
  })
