# @effect-uai/firecrawl

## 0.10.0

### Minor Changes

- 98ee12c: New `WebRead` capability (additive). Turn a URL into clean markdown or HTML,
  then extract typed data from it. It mirrors `WebSearch`: one generic tag,
  several provider layers, and a ready-made tool.
  - **`@effect-uai/core/WebRead`**: the generic `WebRead` tag and `read(request)`
    helper. A request is `{ url, format?, timeout? }`; a response is
    `{ url, content, title?, links?, raw }`. Every implementor answers `read`,
    so the capability needs no marker tags.
  - **`@effect-uai/core/WebReadTool`**: `webReadTool(options?)` hands the
    capability to a model as a tool, the same way `webSearchTool` does for
    search. `Output` is the rendered string; it fails with `AiError`.
  - Four providers register the generic `WebRead` tag, swappable as a Layer:
    `@effect-uai/firecrawl` (new package, JS-rendered pages),
    `@effect-uai/exa/ExaContents`, `@effect-uai/tavily/TavilyRead`, and
    `@effect-uai/jina/JinaReader`.
