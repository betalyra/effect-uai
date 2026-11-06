---
"@effect-uai/core": minor
---

`Tool.make` accepts an optional `outputSchema` (an Effect Schema). `run` must then return the schema's type, and `Toolkit.run` validates and encodes the value through it before it reaches the wire: a `Date` becomes an ISO string, a `Uint8Array` follows its schema's encoding, and a value the schema rejects becomes a model-visible `output_validation_error` result instead of passing through unchecked.

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

Tools without `outputSchema` behave as before. `Tool.withRun` drops `outputSchema`, since the replacement `run` may return a different shape.
