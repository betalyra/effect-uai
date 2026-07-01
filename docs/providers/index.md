---
title: Providers
description: Every backend effect-uai speaks to, and which capabilities each one covers. Browse by provider, then jump to the usage page for the capability you need.
---

Most of these docs are organized by **capability**: language models,
embeddings, speech, and so on. This page flips that around. If you already
use a provider somewhere else and want to know what effect-uai can do with
it, find its row and follow the link to the usage page.

Switching providers is always a Layer swap. Each one registers under both
its own typed tag and the generic capability tag, so code you write against
the generic tag keeps working when you change the backend.

## Capability matrix

Two tables, split on a line the library itself draws. **Model** capabilities
take a `model` id: you pick a model and quality varies by which one. **Web and
sandbox** capabilities have no model: you pick a backend service. A provider
can appear in both (Jina does).

A ✓ links to the usage page for that provider and capability.

### Models

| Provider       | LLM                        | Embeddings                            | Speech                             | Music                                        |
| -------------- | :------------------------: | :-----------------------------------: | :--------------------------------: | :------------------------------------------: |
| **OpenAI**     | [✓](/providers/responses/) | [✓](/embeddings/providers/responses/) | [✓](/speech/providers/openai/)     |                                              |
| **Google**     | [✓](/providers/gemini/)    | [✓](/embeddings/providers/gemini/)    | [✓](/speech/providers/gemini/)     | [✓](/music-generation/providers/gemini/)     |
| **Anthropic**  | [✓](/providers/anthropic/) |                                       |                                    |                                              |
| **Mistral**    | [✓](/providers/mistral/)   |                                       | [✓](/speech/providers/mistral/)    |                                              |
| **ElevenLabs** |                            |                                       | [✓](/speech/providers/elevenlabs/) | [✓](/music-generation/providers/elevenlabs/) |
| **Jina**       |                            | [✓](/embeddings/providers/jina/)      |                                    |                                              |
| **Inworld**    |                            |                                       | [✓](/speech/providers/inworld/)    |                                              |

### Web and sandbox

| Provider         | Web search                         | Web reading                            | Sandbox                                 |
| ---------------- | :--------------------------------: | :------------------------------------: | :-------------------------------------: |
| **Exa**          | [✓](/search/providers/exa/)        |                                        |                                         |
| **Perplexity**   | [✓](/search/providers/perplexity/) |                                        |                                         |
| **Tavily**       | [✓](/search/providers/tavily/)     |                                        |                                         |
| **Firecrawl**    |                                    | [✓](/web-reading/providers/firecrawl/) |                                         |
| **Jina**         |                                    | [✓](/web-reading/providers/jina/)      |                                         |
| **Microsandbox** |                                    |                                        | [✓](/sandboxes/providers/microsandbox/) |
| **Deno**         |                                    |                                        | [✓](/sandboxes/providers/deno/)         |

## OpenAI

`@effect-uai/openai` · `@effect-uai/responses`

GPT models via the Responses API, text embeddings, and speech.

- Language model: [Responses / OpenAI](/providers/responses/)
- Embeddings: [OpenAI](/embeddings/providers/responses/)
- Speech: [OpenAI](/speech/providers/openai/)

## Google

`@effect-uai/google`

Gemini models, Gemini embeddings, Gemini speech, and Lyria music.

- Language model: [Google Gemini](/providers/gemini/)
- Embeddings: [Google Gemini](/embeddings/providers/gemini/)
- Speech: [Google Gemini](/speech/providers/gemini/)
- Music: [Google Lyria](/music-generation/providers/gemini/)

## Mistral

`@effect-uai/mistral`

Mistral chat models plus Voxtral realtime STT and TTS, enough for a full
voice pipeline on one brand.

- Language model: [Mistral](/providers/mistral/)
- Speech: [Mistral (Voxtral)](/speech/providers/mistral/)

## Anthropic

`@effect-uai/anthropic`

Claude models via the Messages API.

- Language model: [Anthropic](/providers/anthropic/)

## ElevenLabs

`@effect-uai/elevenlabs`

Streaming speech-to-text, text-to-speech, and music generation.

- Speech: [ElevenLabs](/speech/providers/elevenlabs/)
- Music: [ElevenLabs Music](/music-generation/providers/elevenlabs/)

## Jina

`@effect-uai/jina`

Text and multimodal embeddings, including multivector output, plus the
Reader for turning URLs into clean markdown.

- Embeddings: [Jina](/embeddings/providers/jina/)
- Web reading: [Jina Reader](/web-reading/providers/jina/)

## Inworld

`@effect-uai/inworld`

Text-to-speech.

- Speech: [Inworld](/speech/providers/inworld/)

## Exa

`@effect-uai/exa`

Neural web search ranked by relevance score.

- Web search: [Exa](/search/providers/exa/)

## Perplexity

`@effect-uai/perplexity`

Fast, current-events web search snippets.

- Web search: [Perplexity](/search/providers/perplexity/)

## Tavily

`@effect-uai/tavily`

Web search with snippets, scores, and depth control.

- Web search: [Tavily](/search/providers/tavily/)

## Firecrawl

`@effect-uai/firecrawl`

JS-rendered pages turned into clean markdown or HTML.

- Web reading: [Firecrawl](/web-reading/providers/firecrawl/)

## Microsandbox

`@effect-uai/microsandbox`

Isolated microVM sandboxes for running model-generated code.

- Sandbox: [Microsandbox](/sandboxes/providers/microsandbox/)

## Deno

`@effect-uai/deno`

Sandboxed code execution on the Deno runtime.

- Sandbox: [Deno Sandbox](/sandboxes/providers/deno/)
