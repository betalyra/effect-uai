# Plan: Gemini updates (Decisions API, Gemini 4 Argon / Carbon)

Status: **planned** (2026-11-11). Own small PR off dev, after video PR 1
and before the video provider packages (PR 2). Two parts: a new
`DecisionModel` adapter (Part A) and what the Gemini 4 models need from the
existing language-model layer (Part B).

# Part A: Decisions API as a `DecisionModel`

Source: https://aistudio.google.com/docs/decisions-api (fetched
2026-11-11; no release date or prices on the page).

## What it is

`POST /v1beta/decisions` with `x-goog-api-key`, model `gemini-decision-1`.
Typed questions about one shared input, answered with probabilities in
one forward pass. Synchronous, no streaming, no batch, no caching. Only
input tokens are billed; output tokens are always 0.

- Request: `model`, `input` (string, a content block or an array of them:
  text, image, audio, video, PDF, same schema as the Interactions API),
  `questions` (1 to 1,000, keys `[A-Za-z0-9_-]{1,64}`).
- Question: `type` (`noul` / `choice` / `score`), `instructions` (text
  only), `criteria` (map of option id to description for `choice`,
  ordered array of 2 to 255 levels for `score`, optional for `noul`).
- Answer: `noul` (0.01 to 0.99) + `confidence`; `choice` + `probabilities`
  - `confidence`; `score` (probability-weighted level index) + `legend` +
    `probabilities` + `confidence`.
- Limits: 262,144-token context; inline data 100 MB (PDF 50 MB); URIs are
  Files API or HTTPS up to 15 MB; choice keys up to 128 chars.
- Errors: HTTP 400 with `error.code` in `safety`, `prohibited_content`,
  `blocklist`, `image_safety`, `content_blocked`; limits and key
  validation also 400.

## Fit with core

No core change. The wire vocabulary is the one `DecisionModel` was
designed against, and the `typesafe-ai` `Jev` adapter speaks nearly the
same dialect:

| core          | Google                                  | Jev                   |
| ------------- | --------------------------------------- | --------------------- |
| `probability` | `noul`, plus `confidence`               | `noul`, no confidence |
| `classify`    | `choice`                                | `choice`              |
| `rate`        | `score`                                 | `score`               |
| `input`       | `input` (string or content blocks)      | `state`               |
| usage         | Interactions-style `total_input_tokens` | `input_tokens`        |

Google's `confidence` is the vendor's own estimate that the top answer is
right; like Jev's, it goes on the provider-typed answer only, never on the
common one (`Decision.confidence` is ours).

## Steps

1. **Spike** (input tokens only, cheap), pinning what the page leaves
   unstated: the `noul` `criteria` shape (`{ true, false }`?), whether
   `score.probabilities` is an array or keyed by index, the exact `usage`
   and error bodies. Responses saved for the codec tests.
2. **`providers/google/src/GeminiDecisionModel.ts`**, modelled on
   `Jev.ts`: provider-typed tag with `confidence` on every kind, the
   generic `DecisionModel` on the same service, all three kinds supported,
   decision names and choice keys validated against Google's limits before
   sending (`InvalidRequest`), safety codes mapped to `AiError`.
   `GeminiDecisionModel` model union in `models.ts`.
3. **Tests**: decode against the spike's real responses, key validation,
   safety error mapping.
4. **Wiring and docs**: a `google:gemini-decision-1` entry in
   `recipes/_shared/model.ts`, a provider page under the decisions docs,
   a changeset (google minor).

## Later

Multimodal input on the Google-typed request (image, audio, video, PDF).
The common `Definition` encodes its input to JSON, so media cannot ride
the common request. Pairs with video: "is this generated clip on brief?"
as a decision.

# Part B: Gemini 4 Argon and Carbon

Researched 2026-11-11 (agent report, sources below; release dates are from
third parties and unverified).

|          | Gemini 4 Argon                                                                                     | Gemini 4 Carbon              |
| -------- | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| Id       | `gemini-4-argon`                                                                                   | `gemini-4-carbon`            |
| GA       | 2026-10-13                                                                                         | 2026-11-10                   |
| Position | faster, fewer thinking tokens                                                                      | most capable reasoning model |
| I/O      | text, image, video, audio, PDF in; text out                                                        | same                         |
| Surfaces | generateContent, Interactions (incl. background), Batch, Flex, Priority; not Live                  | same                         |
| Context  | 1,048,576 shared by input, thinking, output; default max output 65,536, up to ~1M with long decode | same                         |
| Price    | $2 / $10 per 1M until 2026-11-30, then $4 / $20                                                    | same                         |

New compared with earlier Gemini: thinking levels `low` / `medium` /
`high` (default `medium`); long decode (`finishReason: "CONTINUATION"` +
`continuationToken`, resend to continue; 64K per streaming hop); agentic
video understanding (`mediaProcessing: "AGENTIC"` on a video part, answered
with `MEDIA_PROCESSING` tool parts); explicit caching unsupported;
`temperature` / `top_p` / `top_k` ignored.

**The ids work today** through the `Gemini` layer (`GoogleModel` has the
`(string & {})` tail): text, tools, structured output, image input and
thought signatures as on Gemini 3. Adding the literals is autocomplete
only. Three gaps, each checked against the code:

1. **`thinkingLevel` (small).** `ThinkingConfig` is `{ thinkingBudget }`
   only (`codec.ts`), and `GeminiRequest` exposes only the budget. The
   image generator and the Live session already take `thinkingLevel`;
   follow them. Check whether Gemini 4 still accepts `thinkingBudget`.
2. **Long decode (medium).** `finishReasonToStop` maps everything but
   `MAX_TOKENS` to `"stop"`, so a `CONTINUATION` cut reads as a finished
   answer, and neither the candidate decode nor `RequestBody` carries a
   `continuationToken`. Decide the shape: a distinct stop reason the
   caller loops on (explicit, fits "make the loop explicit") rather than
   a hidden auto-continue. Its own small design note before code.
3. **Unknown response parts (small to medium, pre-existing).** The part
   union is text, function call and inline data only, so
   `executableCode` / `codeExecutionResult` (the existing code-execution
   tool) and the new `toolCall` / `toolResponse` parts likely fail the
   decode and end the stream (from reading the code, not run). Skip or
   map unknown parts instead.

Later, not in this PR: video, audio and PDF in user messages (core
`ContentBlock` is text and image; the `input_file` backlog item),
`mediaProcessing`, Maps and file-search tools, an Interactions-based
language-model layer for background long decode.

Sources: https://aistudio.google.com/docs/changelog.md.txt,
https://aistudio.google.com/docs/models/gemini-4-argon.md.txt,
https://aistudio.google.com/docs/models/gemini-4-carbon.md.txt,
https://aistudio.google.com/docs/long-decode.md.txt,
https://aistudio.google.com/docs/video-understanding.md.txt.

# Order

1. Part B.3 first (a decode bug that bites existing users of code
   execution), then B.1 (small), then Part A, then B.2 after its design
   note.
