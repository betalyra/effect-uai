# @effect-uai/slack

Slack provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `Messenger` contract over Socket Mode and the Web API, so your
agent runs as a Slack bot: mentions, DMs, slash commands and button presses
in, streamed markdown replies in a thread, files and reactions out. One
websocket, so no request URL, and no Bolt.

## Install

```sh
pnpm add @effect-uai/slack @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Effect, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { layer as slackLayer } from "@effect-uai/slack/Slack"

const provider = slackLayer({
  botToken: Redacted.make(process.env.SLACK_BOT_TOKEN!),
  appToken: Redacted.make(process.env.SLACK_APP_TOKEN!),
})

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(provider), Effect.provide(NodeHttpClient.layerUndici)),
)
```

The layer registers both the provider-typed `Slack` tag and the generic
`Messenger` tag. The app needs Socket Mode, an `xapp-` app token and an
`xoxb-` bot token; the docs page has a manifest with the scopes and events.

## Threads

By default a top-level mention is answered in a thread under it, and
follow-ups inside that thread are the same conversation. `replyIn: "channel"`
answers in the channel instead.

## Docs

<https://effect-uai.betalyra.com/messenger/providers/slack/>

## License

MIT
