---
"@effect-uai/core": minor
---

`Tool.make` accepts an optional `outputSchema` (an Effect Schema whose encoded side is JSON). `run` must then return the schema's type; `Toolkit.run` checks every value against it, and the schema encodes the value for history and the UI (a `Schema.DateFromString` field becomes an ISO string). A value the schema rejects ends the call with `OutputInvalid` instead of passing through unchecked.

Because the input and output schemas live in a plain object, a tool's spec can be shared with a client and spread into `Tool.make` next to a server-side `run`:

```ts
const GetWeather = {
  name: "get_weather",
  description: "…",
  inputSchema: Input,
  outputSchema: Weather,
} as const
const getWeather = Tool.make({ ...GetWeather, run: ({ city }) => fetchWeather(city) })
```

Without `outputSchema`, `run` returns a `Content.Value`. `Tool.withRun` drops `outputSchema`, since the replacement `run` may return a different shape.
