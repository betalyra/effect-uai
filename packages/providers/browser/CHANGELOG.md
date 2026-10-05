# @effect-uai/browser

## 0.18.0

### Minor Changes

- cea6f3d: `CdpConnectConfig` gains an optional `headers`, sent on the CDP WebSocket handshake. Use it for an endpoint that wants an `Authorization: Bearer <token>` header, such as obscura 0.2.3 and later with `OBSCURA_CDP_TOKEN` set. Handshake headers need Node or Bun; a browser cannot set them.

  A command sent after the CDP connection has ended now fails with `CdpError` of kind `closed` instead of waiting for a connection that never comes.

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.1

## 0.12.0

## 0.11.0

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
