# @effect-uai/telegram

Telegram provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `Messenger` contract over the Bot API, so your agent runs as
a Telegram bot: DMs, group mentions and commands in, streamed HTML replies,
media and reactions out. Long-polling, so no public URL, and no SDK.

## Install

```sh
pnpm add @effect-uai/telegram @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Effect, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"

const provider = telegramLayer({ token: Redacted.make(process.env.TELEGRAM_BOT_TOKEN!) })

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(provider), Effect.provide(NodeHttpClient.layerUndici)),
)
```

The layer registers both the provider-typed `Telegram` tag and the generic
`Messenger` tag. It polls until the scope closes; run one instance per token.

## Markup

Text is sent verbatim with `parseMode: "HTML"` by default. Tell the model to
write Telegram HTML; a message Telegram cannot parse is resent plain.

## Docs

<https://effect-uai.betalyra.com/messenger/providers/telegram/>

## License

MIT
