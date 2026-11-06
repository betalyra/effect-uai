---
"@effect-uai/core": patch
---

`Image.ImageSource` is now typed as a `Schema.Codec` that needs no services, instead of a cast to `Schema.Schema`. Schemas that embed it decode and encode without an `unknown` requirement. The URL variant's `mimeType` is now an exact optional key, matching the `ImageSource` type.
