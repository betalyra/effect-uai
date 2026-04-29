---
title: The loop primitive
description: State, decision, body — the three things an agent loop needs.
---

The core thesis of `effect-uai`: **the user owns the loop**. State is a
plain record; `Decision<S>` (`next(state)` / `stop`) controls iteration;
the body is a `Stream`.

```ts
loop<S, A, E, R>(
  initial: S,
  body: (state: S) => Stream<A | Decision<S>, E, R>,
): Stream<A, E, R>
```

Sugar helpers: `nextAfter(stream, state)` and `stopAfter(stream)` let the
body emit values *and* a terminal decision in one expression.
