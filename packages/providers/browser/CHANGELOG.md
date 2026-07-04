# @effect-uai/browser

## 0.10.0

### Minor Changes

- 98ee12c: New `Browser` capability (additive). Drive a real browser over the Chrome
  DevTools Protocol: navigate, click, fill, press, scroll, and read a page as
  markdown with its interactive elements labeled.
  - **`@effect-uai/core/Browser`**: the generic `Browser` tag and session
    surface, with a typed `BrowserError`.
  - **`@effect-uai/core/BrowserTool`**: verb tools (`gotoTool`, `clickTool`,
    `fillTool`, `pressTool`, `scrollTool`) and `browserToolkit(session)` that
    bundles them, for handing the browser to an agent loop.
  - **`@effect-uai/browser`** (new package): a CDP adapter. Point
    `@effect-uai/browser/Connect`'s `layer({ endpoint })` at any browser-level
    CDP WebSocket, which covers the whole field: a headless Chromium container,
    a local Chrome or Edge, a from-scratch engine like obscura, or a hosted
    browser cloud.
