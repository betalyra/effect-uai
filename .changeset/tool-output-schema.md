---
"@effect-uai/core": minor
---

`Tool.make` takes an `outputSchema` (an Effect Schema whose encoded side is JSON). `run` returns the schema's type; `Toolkit.run` checks every value against it, and the schema encodes the value for history and the UI (a `Schema.DateFromString` field becomes an ISO string). A value the schema rejects ends the call with `OutputInvalid` instead of passing through unchecked. For "anything", use `outputSchema: Content.Value`.

Because the schemas live in a plain object, a tool's spec can be shared with a client and spread into `Tool.make` next to a server-side `run`:

```ts
const GetWeather = {
  name: "get_weather",
  description: "…",
  inputSchema: Input,
  outputSchema: Weather,
} as const
const getWeather = Tool.make({ ...GetWeather, run: ({ city }) => fetchWeather(city) })
```

`Tool.withRun` keeps the descriptor and the schemas; the replacement `run` returns the same output type.
