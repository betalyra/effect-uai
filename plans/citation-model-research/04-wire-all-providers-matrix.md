# Wire: citation / source shapes across all web-search + retrieval providers (2026)

> Research note for the deep-research citation-model appendix. Broad survey
> across LLM providers with a server-side web-search tool (Category A) and
> standalone search / retrieval / answer APIs (Category B).

## 1. Comparison table

### Category A: LLM providers with a server-side web-search tool

| Provider | Citation/source object fields | Span-linking | Doc |
|---|---|---|---|
| Google Gemini `googleSearch` | `groundingChunks[].web.{uri,title}` (source list); `groundingSupports[].{segment:{startIndex,endIndex,text}, groundingChunkIndices[], confidenceScores[]}`; `webSearchQueries[]`, `searchEntryPoint.renderedContent` | char/byte index (`startIndex`/`endIndex`) + `groundingChunkIndices[]` map into source list | ai.google.dev/gemini-api/docs/google-search ; Vertex GroundingMetadata |
| OpenAI Responses `web_search` | annotation `{type:"url_citation", url, title, start_index, end_index}` on `output_text`; separate `web_search_call` item | char index into `output_text` | developers.openai.com/api/docs/guides/tools-web-search |
| Anthropic Messages `web_search` | `{type:"web_search_result_location", url, title, cited_text, encrypted_index}` in each text block's `citations[]`; sources in `web_search_tool_result` -> `{url,title,page_age,encrypted_content}` | none (block + quote): per-text-block `citations[]` + `cited_text` snippet | platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool |
| xAI Grok Live Search / `web_search`/`x_search` | Live Search: `response.citations[]` = plain URL strings. Server-tool: `output_text.annotations[]` = `{url,title,start_index,end_index}` | both: inline markdown `[[N]](url)` AND char-index annotations; bare `citations` list partly unlinked | docs.x.ai/developers/tools/citations |
| Mistral Agents `web_search`/`web_search_premium` | content chunk `{type:"tool_reference", tool, title, url, source}` interleaved among text chunks | interleaved chunks (inline in content list; not offsets, not `[n]`). Only in `/v1/conversations` | docs.mistral.ai/agents/tools/built-in/websearch |
| Cohere Chat v2 (documents + citations) | `message.citations[].{start, end, text, sources[]}`; source `{type, id, document:{id,snippet,title}}`; input `documents[].{id?, data:{title,snippet}}` | char index (`start`/`end`) + exact `text` | docs.cohere.com/docs/rag-citations |
| Amazon Bedrock KB RetrieveAndGenerate | `citations[].{generatedResponsePart:{textResponsePart:{text, span:{start,end}}}, retrievedReferences[]:{content, location, metadata}}` | char index (`span.start`/`span.end`). RAG, not web search | docs.aws.amazon.com/bedrock KB Citation |
| Together AI | none (pairs external Exa) | none | docs.together.ai/docs/ai-search-engine |
| Fireworks AI | none (no built-in web-search-with-citations) | none | - |

### Category B: standalone web-search / retrieval / answer APIs

| Provider | Result / citation fields | Answer-level linking | Doc |
|---|---|---|---|
| Exa `/search` | `id, url, title, publishedDate, author, text, highlights[], highlightScores[], summary, image, favicon, subpages[], extras` (no `score`; rank order is the signal) | none (ranked list) | exa.ai/docs/reference/search |
| Exa `/answer` | `answer` + `citations[].{id,url,title,publishedDate,author,text,image,favicon}` | bare source list | exa.ai/docs/reference/answer |
| Tavily `/search` | `results[].{title,url,content,score,raw_content,favicon,published_date}`; top-level `answer` | bare (`answer` standalone) | docs.tavily.com |
| Brave web/search | `results[].{title,url,description,page_age,profile,meta_url,thumbnail,extra_snippets[],age,language}` | none (summarizer separate endpoint) | api-dashboard.search.brave.com |
| You.com Search | `results.web[].{url,title,description,snippets[],thumbnail_url,page_age,contents,authors,favicon_url}` | none (ranked list + `snippets[]`) | you.com/docs/api-reference/search |
| Linkup `/search` | `sourcedAnswer`: `answer` + `sources[].{name,url,snippet,favicon}`; `searchResults`: `results[].{type,name,url,content,favicon}` | bare source list | docs.linkup.so |
| Jina `s.jina.ai` | per-entry `{url, title, content, timestamp}`; `usage` | none (per-source cleaned content) | jina.ai/reader |
| Jina DeepSearch | `choices[].(delta.)annotations[]` `{type:"url_citation", url, title, exactQuote, dateTime}`; `visitedURLs[], readURLs[]` | quote-anchored (`exactQuote`+url; no offsets) | jina.ai/deepsearch |
| Firecrawl `/search` | `data.web[].{title, description, url, markdown?, html?, rawHtml?, links[], screenshot?, metadata}` | none (content opt-in) | docs.firecrawl.dev |
| SerpAPI organic_results | `{position, title, link, displayed_link, snippet, snippet_highlighted_words[], date, source, favicon, sitelinks, rich_snippet}` | none | serpapi.com/organic-results |
| Perplexity Sonar | `search_results[].{title, url, date, last_updated, snippet, source}`; legacy `citations[]` (removed May 2025) | inline `[n]` markers (1-based into `search_results`) | docs.perplexity.ai |
| Kagi FastGPT | `data.{output, tokens, references[]:{title, snippet, url}}` | inline `[n]` markers in `output` -> `references` | help.kagi.com/kagi/api/fastgpt.html |
| Kagi Enrichment/Search | `{t, rank, url, title, snippet, published}` + `meta` | none | help.kagi.com/kagi/api/enrich.html |
| Bing Web Search API | (historical) `webPages.value[].{id,name,url,displayUrl,snippet,dateLastCrawled,language,deepLinks[]}` | none. RETIRED Aug 11 2025 (410). Replaced by Grounding-with-Bing in Azure AI Foundry | learn.microsoft.com bing-search-api-retirement |

## 2. Synthesis

Common subset (present in essentially every citation/source): `url`, `title` (called `name` in Linkup/Bing). Everything else optional. Near-common (strong majority): `snippet`/`text`/`cited_text`/`content` (source-side excerpt), `publishedDate`/`date`/`page_age`/`dateTime`.

Superset worth modeling. Per-source: `url`, `title`, `snippet/text`, `publishedDate`, `author`, `score`/`highlightScores`, `favicon`, `image`, `source_type` (web/x/news/attachment/document), plus provider-opaque round-trip tokens (Anthropic `encrypted_index`/`encrypted_content`, Gemini chunk index, Cohere `document.id`). Per-span: `start`/`end` char offsets, `text` (exact cited substring), a `sourceRefs[]` list of indices/ids into the source list, optional `confidenceScores[]`.

The 3 distinct citation styles to normalize:
1. Char-span-anchored: answer carries `{start,end}` char (or byte) offsets, each mapped to one or more sources. Richest. OpenAI, Gemini (segment + chunkIndices), xAI annotations, Cohere, Bedrock. Sub-variant quote-anchored (no offsets but an exact `cited_text`/`exactQuote` to string-match): Anthropic, Jina DeepSearch.
2. Inline-marker: model prose contains `[n]` (or `[[n]](url)`) indexing 1-based into an ordered source array; no offsets. Perplexity, Kagi FastGPT, xAI (also), Grounding-with-Bing.
3. Bare source list: sources decoupled from prose (or no prose). Exa `/answer`, Tavily, Linkup, Mistral (interleaved chunks, position-ordered), and pure ranked lists (Exa `/search`, Brave, You.com, Firecrawl, SerpAPI, Kagi Enrichment, Jina reader, legacy Bing).

Recommended unified model: a citation as `{ source, span? }` where:
- `source`: `{ url, title, snippet?, publishedDate?, author?, score?, sourceType?, providerRef? }` (url+title required; `providerRef` holds opaque round-trip tokens).
- `span` discriminated union: `{kind:"char", start, end, sourceRefs[], confidence?}`; `{kind:"quote", text, sourceRefs[]}`; `{kind:"marker", ordinal, sourceRefs[]}`; `{kind:"none"}`/omit (bare list).

Normalization: quote-anchored can be upgraded to char-spans by string-matching `cited_text` against the answer; markers by locating `[n]` positions; Mistral interleaved chunks give ordering only.

Flags (shapes that may change): Gemini transitioning classic grounding -> Interactions API (`url_citation`); `confidenceScores` often unpopulated in the Gemini Developer API. OpenAI/xAI: `web_search` GA but `web_search_preview` legacy lingers; xAI preview-grade. Anthropic: three dated tool versions, identical citation fields. Perplexity: `citations` URL-array removed May 2025, use `search_results`. Bing Web Search API retired (410) since Aug 11 2025. Linkup `depth="fast"` + `structured` beta. Together/Fireworks: no native web-search citations.
