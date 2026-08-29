# tokenizer integration test

End-to-end test for `HuggingFaceTokenizer` from `@effect-uai/retrieval`.
Downloads real vocabularies from the Hugging Face Hub and runs them
through the core `Tokenizer` tag and through `Chunking`.

Excluded from the default `pnpm test` run: it needs the network, and a
Hub outage should not fail the pipeline.

Unlike the sandbox suites this one is a normal workspace member, since
`@huggingface/tokenizers` is dependency-free pure JS.

## Prerequisites

- The workspace built once from the repo root: `pnpm build`
- Network access to `huggingface.co` on the first run. No API key: both
  models are public and ungated.

## Run

```bash
pnpm test:integration:tokenizer
```

Vocabularies land in `.cache/tokenizers/` (gitignored, ~6 MB) on the
first run and are read from there afterwards, which is the same path an
application takes: `download` once, `fromDefinition` from then on.
Delete the folder to fetch again.

## What it covers

- `decode(encode(text)) === text` for prose, accents, emoji, CJK,
  whitespace, and the empty string, with no special tokens added.
- Two models producing different ids for the same text, so the suite
  fails if the definition ever stops driving the tokenizer.
- A definition through `JSON.stringify` and back out of the `Definition`
  schema matching the live one.
- `Chunking.withTokenizer` holding a token budget measured over the real
  vocabulary, with chunk offsets still indexing the input.
- `layer` downloading and building in one step.
- A missing repo failing with `TokenizerLoadError` rather than throwing.

## Models

| Repo                         | tokenizer.json | Why                            |
| ---------------------------- | -------------- | ------------------------------ |
| `Qwen/Qwen3-0.6B`            | ~11 MB         | Current-generation BPE         |
| `HuggingFaceTB/SmolLM2-135M` | ~2 MB          | A second, unrelated vocabulary |

Both are public. Gated repos (Google's among them) need a token; pass
one as `token: Redacted.make(process.env.HF_TOKEN)` and the layer sends
it as a bearer header.
