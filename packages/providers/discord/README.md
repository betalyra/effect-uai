# @effect-uai/discord

Discord provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `Messenger` contract over the gateway and the v10 REST API, so
your agent runs as a Discord bot: DMs, channel mentions, threads and button
presses in, streamed markdown replies, media and reactions out. One gateway
websocket, so no public URL, and no discord.js.

## Install

```sh
pnpm add @effect-uai/discord @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Effect, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { layer as discordLayer } from "@effect-uai/discord/Discord"

const provider = discordLayer({ token: Redacted.make(process.env.DISCORD_BOT_TOKEN!) })

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(provider), Effect.provide(NodeHttpClient.layerUndici)),
)
```

The layer registers both the provider-typed `Discord` tag and the generic
`Messenger` tag. Building it waits for Discord's `READY`, so a bad token
fails at wiring time; the session stays live until the scope closes.

## Intents

The default intents cover DMs and mentions. Reading every channel message
needs the privileged Message Content intent:
`intents: Discord.defaultIntents | Discord.Intents.MessageContent`.

## Docs

<https://effect-uai.betalyra.com/messenger/providers/discord/>

## License

MIT
