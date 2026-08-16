export * as OpenAITranscriber from "./OpenAITranscriber.js"
export * as OpenAISynthesizer from "./OpenAISynthesizer.js"
export * as codec from "./codec.js"
export * from "./models.js"
export * from "./region.js"
// Re-exported OpenAI surfaces whose physical home is `@effect-uai/responses`
// (LLM, embeddings, deep research, built-in tools). Namespaced to avoid the
// `Config` / `resolveHost` name clashes with the speech modules above.
export * as Responses from "./Responses.js"
export * as OpenAIEmbedding from "./OpenAIEmbedding.js"
export * as OpenAIDeepResearch from "./OpenAIDeepResearch.js"
export * as ResponsesTools from "./ResponsesTools.js"
