# Plan: EmbeddingModel capabilities revamp

Companions: [capabilities.md](./capabilities.md) (the guideline) ·
[embeddings.md](./embeddings.md) (the design doc + 7-provider survey) ·
[tts-revamp.md](./tts-revamp.md) / [stt-revamp.md](./stt-revamp.md) /
[music-revamp.md](./music-revamp.md) (siblings, same three-bucket method).

Embeddings have **3 providers / 3 Layers** in tree: OpenAI
(`@effect-uai/responses`), Gemini (`@effect-uai/google`), Jina
(`@effect-uai/jina`). Each registers a provider-typed tag plus the
generic `EmbeddingModel` tag.

The headline: **no `AiError.Unsupported` exists anywhere in the
embedding domain or its three providers today.** Every capability gap
is currently either an `InvalidRequest` (wrong bucket) or a silent
`as` cast (a type-level lie). This revamp introduces the bucket-1
rejections the guideline requires and trims one provider-specific
intruder out of the Common request.

---

## 1. Current state

### 1.1 Right, keep as-is

- One service, two methods (`embed` / `embedMany`), each one HTTP call.
  No auto-batching (deliberate, [embeddings.md](./embeddings.md#L402)).
- `model` narrowed on every provider request
  (`Omit<…,"model"> & { model: <Union> }`) . §3.4 done.
- `task` widened to provider enums on the typed path (`GoogleEmbeddingTask`,
  `JinaTask`); the Common `task` stays the universal `"query" | "document"`
  axis. §3.4 done.
- `dimensions` lives on the request (per-collection runtime decision);
  per-model rejections pass through as a provider 400 (§2.3). Discrete-value
  providers (Cohere, Vertex) validate per-Layer when they land.
- Gemini `url`-image reject stays `InvalidRequest` . genuine wire-shape
  (§3.5): the Files-API upload isn't free, pass base64/bytes.
  [GeminiEmbedding.ts:109-114](../packages/providers/google/src/GeminiEmbedding.ts#L109).
- Jina decodes + verifies `encoding` against the response shape
  ([JinaEmbedding.ts:327-354](../packages/providers/jina/src/JinaEmbedding.ts#L327)).
  Correct (the only provider that honors non-float32).

### 1.2 What changes

- **`input` image / multi-part rejected as `InvalidRequest` → `Unsupported`**
  (bucket 1, §14.2). Two sites still wrong despite §14.2 marking them
  "addressed".
- **`encoding` cast-lie on OpenAI + Gemini generic tags → `Unsupported`**
  (bucket 1). New finding, not in §14.
- **`task` silently dropped on OpenAI generic path → `warnDropped`**
  (bucket 2, §14.5).
- **Core `EmbedEncoding` trimmed** from 5 values to the dense-quantization
  trio; `sparse` + `multivector` are Jina-only intruders that move out of
  Common (the `DialogueTurn` parallel).
- **Shared `assertEncoding` core helper** for the float32-only guard.

### 1.3 Markers . deferred

`ImageEmbeddingGuarantee` (§7 Tier 2) is the only candidate. Both
in-tree multimodal Layers are **mixed-model** (Gemini routes to
text-only models too; Jina v3 is text-only, v4 / clip multimodal), so
§5 pessimism omits the marker from both . no clean in-tree home.
Defer, exactly as the STT markers were deferred (additive to `R`, land
anytime). Real discrimination arrives with a single-modality
multimodal Layer (Cohere v4, a jina-clip-only Layer) or a documented
consumer.

---

## 2. The Common request, bucketed

`CommonEmbedRequest = { input, model, task?, dimensions?, encoding? }`
(+ `inputs` on the batch variant).

| Field        | Bucket       | Verdict                                                                        |
| ------------ | ------------ | ------------------------------------------------------------------------------ |
| `input`      | 1 (shape)    | Common. Image / multi-part arms reject as `Unsupported` on text-only.          |
| `model`      | §3.4 narrow  | Common. Done.                                                                  |
| `task`       | 2 (explicit) | Common (`query`/`document` universal axis). Per-Layer gap warns.               |
| `dimensions` | 1 (shape)    | Common. Wired everywhere; per-model rejects pass through (§2.3).               |
| `encoding`   | 1 (shape)    | **Split:** `float32`/`int8`/`binary` common; `sparse`/`multivector` Jina-only. |
| `inputs`     | 1 (shape)    | Common. Batch-size limits are runtime, not type-shape.                         |

---

## 3. Changes

### 3.1 Image / multi-part input → `Unsupported` (§14.2)

The wire can carry images; these providers just can't represent the
requested input shape. That's a capability gap (bucket 1), not a
malformed request (§3.5). Silent-drop equivalent = a vector that
represents the wrong thing.

- **OpenAI**: `imageRejected` switches `InvalidRequest` → `Unsupported`
  (`capability: "imageEmbedding"`). Covers `{ image }` and any image part
  in `content[]`.
  [OpenAIEmbedding.ts:67-92](../packages/providers/responses/src/OpenAIEmbedding.ts#L67).
- **Jina**: `multiPartContentRejected` switches `InvalidRequest` →
  `Unsupported` (`capability: "multiPartInput"`). Jina's flat `input[]`
  can't fuse a multi-part `content[]` into one vector; single-part stays
  supported.
  [JinaEmbedding.ts:138-142](../packages/providers/jina/src/JinaEmbedding.ts#L138).

Both hit the typed **and** generic paths (the reject lives in the codec /
impl, which both registrations share). Gemini's `url` reject is
untouched (genuine wire-shape, §1.1).

### 3.2 Trim `EmbedEncoding`; `sparse` + `multivector` leave Common

`EmbedEncoding` conflates two axes and only one is cross-provider:

| Value         | Axis           | Providers                        | Verdict       |
| ------------- | -------------- | -------------------------------- | ------------- |
| `float32`     | quantization   | all 7                            | common        |
| `int8`        | quantization   | Cohere, Voyage, Mixedbread       | common        |
| `binary`      | quantization   | Cohere, Voyage, Jina, Mixedbread | common        |
| `sparse`      | representation | **Jina `elser-v2` only**         | Jina-specific |
| `multivector` | representation | **Jina v4 only**                 | Jina-specific |

[embeddings.md](./embeddings.md#L53): "Sparse is essentially Jina v4
only." `sparse`/`multivector` are a different vector _structure_, not a
storage option . the embedding analog of `DialogueTurn.styleDescription`.

- Core `EmbedEncoding` → `"float32" | "int8" | "binary"`
  ([EmbeddingModel.ts:26](../packages/core/src/embedding-model/EmbeddingModel.ts#L26)).
- `JinaEncoding` keeps `"float32" | "binary" | "sparse" | "multivector"`
  (already there, the `task`-widening pattern)
  ([JinaEmbedding.ts:66](../packages/providers/jina/src/JinaEmbedding.ts#L66)).
- **`Embedding` response union and `EmbeddingFor<E>` are unchanged** . they
  keep all 5 arms. The response describes what came _back_ (a Jina response
  really can be sparse), and Jina's typed `EmbedResponse<E extends JinaEncoding>`
  still feeds `sparse`/`multivector` literals into `EmbeddingFor`.
  [Embedding.ts:97-131](../packages/core/src/embedding-model/Embedding.ts#L97).
- Fix the `EmbedEncoding` JSDoc: it currently says provider layers "reject
  unsupported values up front with `InvalidRequest`" . wrong twice (they
  lie, not reject; bucket 1 wants `Unsupported`).

### 3.3 `encoding` cast-lie → `Unsupported` (bucket 1)

OpenAI and Gemini emit float32 only. Their generic registrations call
the impl and `as`-cast the result to `EmbedResponse<E>`:

```ts
// today, OpenAIEmbedding.ts:278 / GeminiEmbedding.ts:355
embed: <E>(req) => s.embed(req as OpenAIEmbedRequest) as Effect.Effect<EmbedResponse<E>, …>
```

`embed({ encoding: "int8" })` via the generic tag is **typed**
`Int8Embedding` but **returns** `{ _tag: "float32", vector: Float32Array }`
at runtime. The cast is runtime-erased; it relabels a float32 as int8.
A caller storing that in an int8 column or running int8 math gets wrong
bytes / wrong magnitudes . silently broken (bucket 1), not degraded.

Fix: each float32-only generic registration guards the encoding before
delegating. Once only `float32`/`undefined` can flow through, the cast
is **sound** (`EmbeddingFor<"float32" | undefined> = Float32Embedding`,
which is what the runtime returns).

```ts
embed: <E>(req) =>
  assertEncoding(req.encoding, ["float32"], "openai").pipe(
    Effect.flatMap(() => s.embed(req as OpenAIEmbedRequest)),
  ) as Effect.Effect<EmbedResponse<E>, …>
```

Applies to OpenAI + Gemini + Jina, single + batch, generic registration
only (the typed requests `Omit` `encoding`, so the typed path can't pass it).
OpenAI / Gemini guard `["float32"]`; Jina guards `["float32", "binary"]`: it
honors `binary`/`sparse`/`multivector` but NOT scalar `int8` (Jina's "binary
packed as int8" is bit quantization, our `binary`, not scalar int8 per
dimension), and verifies at the response level. Cohere / Voyage, when they
land, support all of core's `EmbedEncoding` (`float32`/`int8`/`binary`), so
they need no guard.

### 3.4 `assertEncoding` core helper

Per the "no per-provider shortcuts over generic helpers" rule, one
audited helper, used by every dense-only provider:

```ts
// packages/core/src/embedding-model/EmbeddingModel.ts (or a sibling)
export const assertEncoding = (
  encoding: EmbedEncoding | undefined,
  supported: ReadonlyArray<EmbedEncoding>,
  provider: string,
): Effect.Effect<void, AiError.AiError> =>
  encoding === undefined || supported.includes(encoding)
    ? Effect.void
    : Effect.fail(
        new AiError.Unsupported({
          provider,
          capability: "encoding",
          reason: `${provider} emits ${supported.join(" / ")} only; encoding="${encoding}" is unavailable.`,
        }),
      )
```

Takes the supported set (not hardcoded float32) so a future provider that
supports a strict subset reuses it. OpenAI / Gemini pass `["float32"]`.

### 3.5 `task` warn on the OpenAI generic path (§14.5)

OpenAI has **no** task field on **any** model . a per-Layer gap, not
per-model . so the generic registration warns when `task` is set:

```ts
yield *
  Capabilities.warnDroppedWhen(req.task, {
    provider: "openai",
    capability: "task",
    field: "task",
    reason: "OpenAI embeddings have no task-type parameter.",
  })
```

(The typed `OpenAIEmbedRequest` already `Omit`s `task`, so only the
generic path can carry it.)

Gemini is **per-model**: `gemini-embedding-001` honors `taskType`,
`gemini-embedding-2` ignores it server-side. Per §2.3 we don't keep
per-model tables, and there's no wire error to translate (the server
silently ignores). Warning unconditionally would false-fire on `-001`
where `task` _is_ honored. So Gemini's `task` stays **silent**, documented
in the existing JSDoc
([GeminiEmbedding.ts:26-31](../packages/providers/google/src/GeminiEmbedding.ts#L26)).
This refines §14.7 ("should warn") the same way [stt-revamp §2.1](./stt-revamp.md#L100)
refined §14.3. (See §5 . open decision.)

---

## 4. Cross-provider matrix

S structured · — unsupported (bucket-1 `Unsupported`) · W warn · M per-model

|               | OpenAI                 | Gemini                               | Jina                                    |
| ------------- | ---------------------- | ------------------------------------ | --------------------------------------- |
| `input` text  | S                      | S                                    | S                                       |
| `input` image | — `imageEmbedding`     | S (base64/bytes; url→InvalidRequest) | S single (multi → `multiPartInput`)     |
| `task`        | W (no field)           | S `-001` / silent `-2` (M)           | S (mapped query/document)               |
| `dimensions`  | M (3-large/small; 400) | S `outputDimensionality`             | S                                       |
| `encoding`    | float32 only (else —)  | float32 only (else —)                | float32/int8?/binary/sparse/multivector |

(Jina honors `int8`? . no: `JinaEncoding` is `float32`/`binary`/`sparse`/`multivector`;
`int8` is supported by Cohere/Voyage/Mixedbread, not in tree yet.)

### 4.1 Expansion providers (forward look, [embeddings.md](./embeddings.md#L38))

| Provider   | image | task                | quant (int8/binary)       | sparse/multivector |
| ---------- | ----- | ------------------- | ------------------------- | ------------------ |
| Cohere v4  | yes   | `input_type` req.   | int8/binary/uint8/ubinary | no                 |
| Voyage     | yes   | query/document/null | int8/binary/uint8/ubinary | no                 |
| Mixedbread | (lim) | free-form `prompt`  | int8/binary/uint8/ubinary | no                 |
| Vertex     | yes   | matches Gemini      | dense float only          | no                 |

Cohere/Voyage/Mixedbread support `int8`/`binary` (core's trimmed set), so
no float32-only guard. None ship `sparse`/`multivector` . confirms the
§3.2 trim. Discrete-`dimensions` providers (Cohere, Vertex
`multimodalembedding@001`) get a per-Layer `dimensions` validation when
they land (bucket 1, per-Layer guard is fine).

---

## 5. Open decisions

Settled (this session): **(a)** trim `EmbedEncoding` to the dense trio;
**(b)** reject non-float32 encoding on float32-only providers with
`Unsupported`; **(c)** shared `assertEncoding` core helper; **(d)** defer
`ImageEmbeddingGuarantee`.

Resolved with rationale, flagged for override:

1. **Jina multi-part `content[]` → `Unsupported`** (not `InvalidRequest`).
   Follows §14.2 verbatim and matches the OpenAI image fix: "this provider
   can't represent this input shape" is a capability gap. _Override path:_
   keep `InvalidRequest` if you read the flat-`input[]` limitation as
   genuine wire-shape (§3.5).
2. **Gemini `task` stays silent** on `gemini-embedding-2` (§3.5 above).
   _Override path:_ warn unconditionally when `task` is set (honors §14.7
   literally, at the cost of a false warning on `gemini-embedding-001`).

---

## 6. Sequencing

Core first (providers resolve `@effect-uai/core` via built **dist**, so
rebuild core before the provider edits compile):

1. **Core**: trim `EmbedEncoding` to `float32 | int8 | binary`; add
   `assertEncoding`; fix the `EmbedEncoding` JSDoc. `Embedding` /
   `EmbeddingFor` unchanged. Rebuild core dist.
2. **OpenAI**: `imageRejected` → `Unsupported`; generic registration adds
   `assertEncoding(…, ["float32"], "openai")` + `warnDroppedWhen(task)`.
3. **Gemini**: generic registration adds `assertEncoding(…, ["float32"],
"gemini")`. `task` silent (no change). `url` reject unchanged.
4. **Jina**: `multiPartContentRejected` → `Unsupported`. Encoding handling
   unchanged.
5. **Tests**: pure-codec / decode tests stay; add `Unsupported` coverage
   only where it's a pure function (mirror the Gemini `realizeOutput`
   pattern . no live-layer runtime-reject tests).

Breaking Common-shape change: `EmbedEncoding` drops `sparse` +
`multivector`. Generic-path callers passing `encoding: "int8" | "binary"`
to OpenAI/Gemini now get `Unsupported` instead of a mislabeled float32
(a correctness fix surfacing as a new error).

---

## 7. Effort

| Phase                                                    | Effort     |
| -------------------------------------------------------- | ---------- |
| Core: trim `EmbedEncoding` + `assertEncoding` + JSDoc    | Small      |
| OpenAI: image `Unsupported` + encoding guard + task warn | Small      |
| Gemini: encoding guard                                   | Small      |
| Jina: multi-part `Unsupported`                           | Mechanical |
| Markers (`ImageEmbeddingGuarantee`)                      | Deferred   |
| Changeset / migration note                               | Deferred   |
