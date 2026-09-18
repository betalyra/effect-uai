---
"@effect-uai/core": minor
---

Add the `DecisionModel` capability: typed questions about one input, answered with a probability distribution each, all in one call. The first provider is `@effect-uai/typesafe-ai/Jev`.

A decision model returns no text. You declare what you want to know and what the possible answers are, hand it the input, and read probabilities back. Every question in a definition is answered in one call against one input, and the input is billed once, so batching questions is the unit of work. The routing rule stays in your code.

- `@effect-uai/core/Decision` holds the three kinds and the definition. `Decision.classify` picks one of a set of named labels, `Decision.rate` places the input on an ordered rubric, `Decision.probability` asks how likely one statement is to hold. `Decision.make({ inputSchema, decisions })` binds a set of them to the schema that encodes the input, so a field the schema omits never reaches the model.
- Answers are typed by the definition. `answers.department.labels.billing` is a `number` and an unknown label is a compile error; a `rate` answer's `levels` is a tuple the length of the rubric, with the rubric echoed as `legend` so an index reads back as prose.
- Reading helpers, identical whichever provider is wired: `winner`, `ranked`, `margin`, `confidence`, `topLevel`, `expectedLevel`. `confidence` is 1 minus normalised entropy and depends on the label count, so gate on the top probability and `margin` instead; the docs say why with a live example.
- `@effect-uai/core/DecisionModel` holds the `DecisionModel` tag, `CommonDecideRequest { input, model }`, `DecideResponse { answers, usage }` and the `decide(definition, request)` accessor. `Decision.assertKinds` is for implementors that cannot express every kind: it fails `AiError.Unsupported` naming every offending decision at once.
- `@effect-uai/core/Probability` holds the keyless certainty math (`confidence`, `margin`) over any probability vector.

Marked `@experimental`: this class of model is new and the shape may change. Probabilities sum to 1 within one answer; calibration is a property of the Layer and documented per provider, and no threshold transfers between models.
