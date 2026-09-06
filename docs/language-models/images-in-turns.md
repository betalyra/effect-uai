---
title: Images in a turn
description: A few models answer with pictures instead of just text. They arrive as blocks on the turn, and carry into the next one.
---

Usually you want an image, so you call [`generate`](/image-generation/)
and get one. Sometimes the picture is part of what the model is
_saying_: it replies with a sentence and a diagram, and "make it dawn
instead" changes that same picture.

Only Google's image models do this today. If you are not using them, you
want [image generation](/image-generation/) instead.

## Reading them

No new service. It is the `turn` call you already make:

```ts
const turn =
  yield *
  gemini.turn({
    model: "gemini-3.1-flash-image",
    history: [ask("Draw a lighthouse at dusk")],
  })

assistantImages(turn) // ImageSource[]
assistantText(turn) // often ""
```

The image is a content block on the assistant's message,
`{ type: "output_image", source }`, holding the same `ImageSource` as an
`input_image`. `assistantImages` pulls them out in order.

**Do not count on the text.** These models tend to put everything in the
picture, words included, and return no `output_text` at all.

## Changing them

Replay the turn and the model edits what it drew:

```ts
const dawn =
  yield *
  gemini.turn({
    model: "gemini-3.1-flash-image",
    history: [...first.items, ask("The same lighthouse, now at dawn")],
  })
```

The adapter puts the image back on the wire as a model-role part, which
is what gives "the same lighthouse" something to refer to.

## Streaming

`ImageOutput` joins the `TurnEvent` union:

```ts
ImageOutput: { image: ImageSource; partialIndex?: number }
```

`partialIndex` marks a preview frame where a provider streams them.
Gemini sends the picture whole, so you get one event with the finished
image. It also lands on `TurnComplete.turn`, so reading only the
assembled turn misses nothing.

## Showing one to a different model

Only Gemini's wire has a slot for an assistant-drawn image. Everywhere
else it is dropped on replay, with a warning saying so.

To hand the picture to another model, say so explicitly:

```ts
const described =
  yield *
  claude.turn({
    model: "claude-sonnet-5",
    history: [...imagesAsInput(previous.items), ask("What is in this image?")],
  })
```

`imagesAsInput` adds a user message carrying the same pictures as
`input_image`. It is a call you make rather than something the adapter
does quietly, because "the assistant drew this" and "here is an image,
look at it" are not the same claim.

## Asking for pictures

There is no shared switch for this, so it stays provider-specific. On
Gemini it is the model: an image model asks for the IMAGE modality on
your behalf, since answering in prose would be a disappointment rather
than an error. Both knobs live on `GeminiRequest`:

```ts
gemini.turn({
  model: "gemini-3.1-flash-image",
  imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
  responseModalities: ["TEXT"], // hold it to prose
  history,
})
```
