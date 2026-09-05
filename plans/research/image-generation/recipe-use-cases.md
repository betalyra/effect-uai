# Subagent report: image generation recipe use cases (2026-09-04)

Raw research report. Summarised in
[../image-generation.md](../image-generation.md).

## Landscape summary

Every major vendor now ships image generation in two shapes: a standalone endpoint (OpenAI Images API `generate`/`edit` with mask + `input_fidelity`; Gemini `response_modalities: ["image"]`; BFL Kontext / fal / Replicate) and a **built-in tool inside an agent loop** (OpenAI Responses `image_generation` tool with `previous_response_id`, `revised_prompt`, `partial_images`; Gemini Interactions API with `previous_interaction_id` and "multimodal function calling"; OpenAI Agents SDK `ImageGenerationTool`; Vercel AI SDK `ToolLoopAgent` + `openai.tools.imageGeneration()`). The second shape is exactly effect-uai's territory, so the recipes should lean on it.

Cross-vendor capabilities that are genuinely uniform: text-to-image, edit-with-reference-images (up to 10-16 refs), multi-turn conversational editing, quality/speed tiers (gpt-image-2 `quality`, Nano Banana 2 Lite vs 2 vs Pro, FLUX schnell/dev/pro). Non-uniform: explicit mask inpainting (OpenAI yes, Gemini "semantic masking" via prompt only), partial image streaming (OpenAI only), transparent background (OpenAI native), search grounding (Gemini only).

## Candidate use cases

### 1. Conversational image editing session (multi-turn edit loop)

User uploads or generates an image, then iterates ("make the background a beach", "now add sunglasses"), each turn building on the last. This is _the_ headline feature of every 2025-26 image model launch.

Evidence: OpenAI guide's Responses API section ("build multi-turn conversations involving image generation... using `previous_response_id`") [OpenAI](https://developers.openai.com/api/docs/guides/image-generation); Gemini docs "multi-turn conversational editing" [Google](https://ai.google.dev/gemini-api/docs/image-generation); BFL Kontext "iterative editing" plus the explicit drift warning after ~6 edits [BFL](https://bfl.ai/blog/flux-1-kontext); gpt-image-1.5 prompting guide's "restate invariants on every iteration to prevent drift" [OpenAI cookbook](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide); Figma/Adobe/Canva all shipped this UX [PetaPixel](https://petapixel.com/2025/04/24/chatgpts-popular-new-image-generator-coming-to-adobe-figma-canva-and-more/).

Needs: edit with reference image, agent loop with image tool, conversation state, optionally partial-image streaming.

Teaching value: high. It is the agentic-loop recipe applied to a new modality: the model decides `generate` vs `edit`, the loop carries prior image ids, and drift handling (re-anchor to the original reference every N turns) is a real production gotcha worth encoding.

### 2. Illustrated story / storyboard with character consistency (LLM plans, image model renders)

An LLM turns a script, book chapter, or brief into a structured shot list; character portraits are generated first, then each scene is rendered with those portraits as references. Comics, kids' books, video pre-viz, e-learning characters.

Evidence: Google cookbook `Book_illustration.ipynb` does exactly this: Pydantic-schema JSON of `{name, prompt}` per character/scene, character portraits generated first, passed as references, sequential via interaction ids [GitHub](https://github.com/google-gemini/cookbook/blob/main/examples/Book_illustration.ipynb); Google codelab "Generating Consistent Imagery" (character sheets, asset graph) [codelab](https://codelabs.developers.google.com/gemini-consistent-imagery-notebook); Nano Banana 2 spec: 5 characters + 14 objects per workflow; gpt-image-2 thinking mode "up to eight coherent images from a single prompt" for storyboards [nemovideo](https://www.nemovideo.com/blog/gpt-image-2-storyboard); OpenAI cookbook "comic-style reels with multiple panels".

Needs: structured output, multi-reference edit, sequential generation (or batch with shared refs), optional vision check.

Teaching value: highest. Shows structured output feeding image generation, reference-image threading, and a two-stage pipeline (plan, then render) in Stream/Effect terms. Composes text LLM + ImageGenerator naturally.

### 3. Product photography: background swap / scene placement from catalog data

Take a product cutout (or transparent asset) and place it in N lifestyle scenes for campaigns, marketplaces, seasonal banners. The most-cited commercial use across all vendors.

Evidence: OpenAI cookbook "Transparent image assets for campaigns" (e-commerce, transparent PNG, batch over a prompt dict, composite later) [OpenAI](https://developers.openai.com/cookbook/examples/multimodal/transparent-image-assets-for-campaigns-and-presentations); "High input fidelity" cookbook: product extraction, background replacement, logo preservation [OpenAI](https://developers.openai.com/cookbook/examples/generate_images_with_high_input_fidelity); BFL Kontext "product mockups by replacing backgrounds while keeping pose and lighting"; fal's own canonical customer: "listing tool that renders property images / creative platform generating campaign assets", customers Photoroom, Freepik [fal review](https://www.buildfastwithai.com/ai-tools/fal-ai); Replicate: Recraft/Ideogram for on-brand social graphics.

Needs: edit with high input fidelity, transparent background (OpenAI) or reference-image compositing, batch/parallel, speed tier for drafts and quality tier for finals.

Teaching value: medium-high. It's mostly "edit with reference" but the interesting part is `Effect.forEach` with concurrency + tiering + typed product records driving prompts. Could merge with #4.

### 4. Ad-creative variant matrix from a structured brief

LLM emits a JSON array of N prompt variants (hook, mood, setting, aspect ratio) from a product brief; images generated in parallel; results scored. The dominant "growth marketing" workflow.

Evidence: practitioner guide: structured brief, 15-30 raw variants, variation matrix over hook/visual/CTA, QA down to 6-10 [adlibrary](https://adlibrary.com/posts/guide-to-ai-ad-creative-generation); "LLMs generate 10 prompts for ad image variations... output parsers convert into structured arrays" [dumpling](https://dumplingai.substack.com/p/generate-ad-image-variations-using); Nano Banana use-case list #9 "multiple ad variations for campaign testing" [substack](https://developersjourney.substack.com/p/15-insane-use-cases-of-google-nano-banana); Figma plugins marketed explicitly for "ad creatives & UI/UX mockups".

Needs: structured output, batch/parallel text-to-image or edit, speed tier.

Teaching value: high for effect-uai specifically: Schema-typed variant list, `Effect.forEach(concurrency)`, cheap model for exploration, expensive for the shortlist.

### 5. Generate, critique, regenerate (vision LLM as judge)

Generate an image, have a vision model check it against constraints (text spelled correctly, logo intact, brand rules, product not distorted), and re-prompt or pick best-of-N.

Evidence: research is thick (VisionDirector, "Iterative Refinement Improves Compositional Image Generation", generate-critique-refine loops) [arXiv](https://arxiv.org/html/2512.19243); production QA: three-layer pipeline with GPT-4o as "creative director" [Medium](https://medium.com/madailab/building-an-ai-powered-creative-qa-system-combining-heim-metrics-with-llm-based-marketing-judgment-0c8b14be7c7b), multimodal-LLM brand compliance with strict JSON [DZone](https://dzone.com/articles/automating-visual-brand-compliance-multimodal-llm); OpenAI's `revised_prompt` and Gemini's "thinking" interim images show vendors internalising the same loop. Less "template-common" than 1-4 but a standard production hardening step.

Needs: text-to-image, vision LLM, structured output (verdict schema), retry/loop.

Teaching value: high. It mirrors the existing `model-retry` / `model-council` recipes: `Loop` with a typed critic verdict, best-of-N via `Effect.race`/`forEach`, a budget cap. Nothing else in the set exercises image _input_ to the LLM.

### 6. Thumbnail / avatar generator from a face reference

YouTube thumbnails, profile avatars, headshots: one face photo + title text + style.

Evidence: NanoThumbnail (OSS, up to 14 refs, prompt enhanced by LLM, Replicate or Gemini) [GitHub](https://github.com/yoanbernabeu/NanoThumbnail); OpenAI high-fidelity cookbook "face preservation... avatar creation"; Replicate headshot generators via FLUX fine-tunes. Common, but it's a thin layer over #1/#3 with face-in-reference, plus identity/safety concerns. Fold into #3 as a variant rather than a separate recipe.

### 7. Image localization (translate in-image text)

Nano Banana 2 and gpt-image-2 both advertise "translate and localize text within an image" [Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-nano-banana-2/). Real for marketing teams, but as a recipe it's a single edit call with a prompt; only interesting if combined with #4's matrix (locale as a dimension) or #5's judge (verify the rendered text). Fold in.

### 8. Infographic / diagram / UI mockup from data

Gemini docs list infographics; OpenAI guide lists UI mockups, "visual wiki" assets; gpt-image-2 launch stressed slides and infographics [VentureBeat](https://venturebeat.com/technology/openais-chatgpt-images-2-0-is-here-and-it-does-multilingual-text-full-infographics-slides-maps-even-manga-seemingly-flawlessly). Nice pairing with existing `dashboard-briefing` (LLM summarises data, image model draws the poster) but output fidelity is prompt-only and hard to verify without #5.

## Ranking (pick these)

1. **storyboard / illustrated-story** (#2): structured output, multi-reference consistency, sequential pipeline. The strongest "image gen composes with everything" recipe, and both Google and OpenAI ship first-party examples of it.
2. **conversational-image-edit** (#1): the agent-loop-with-image-tool recipe; add the drift-guard. Mirrors `agentic-loop`.
3. **ad-variant-matrix** (#4, absorbing #3 product placement and #7 locale as matrix dimensions): typed brief -> Schema list of variants -> parallel generation with speed/quality tiers.
4. **critique-and-regenerate** (#5): vision LLM judge with typed verdict + bounded retry; the only recipe demonstrating image _input_ and quality control. Mirrors `model-retry`.
5. (optional) **product-scene-swap** (#3) as a small standalone if you want one pure edit-with-fidelity recipe; otherwise keep it inside #3.
6. (optional) **partial-image-streaming** as an OpenAI-only variant of #1, matching `streaming-tool-output`.

## Reject as gimmicks or too thin

- Standalone avatar/headshot (#6): identity-sensitive, just #3 with a face.
- Standalone localization (#7): one edit call.
- Style transfer alone: a prompt, no composition.
- Search-grounded image generation (Gemini-only "weather poster"): cute, single-vendor, no loop.
- Video-to-image, 3D, LoRA fine-tuning: resource management, out of scope per package rules.
- Infographic from data (#8) as its own recipe: unverifiable output unless paired with #5; better as a paragraph in the docs.

## Design notes for the capability

Common request should cover: prompt, reference images (list), quality tier, size/aspect, n. Keep mask inpainting, transparent background, partial streaming, and search grounding provider-typed (not uniform). The `Loop` integration needs image outputs as first-class tool results so #1 and #2 can thread image ids/bytes back into context.

Sources: [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation), [OpenAI transparent-assets cookbook](https://developers.openai.com/cookbook/examples/multimodal/transparent-image-assets-for-campaigns-and-presentations), [OpenAI high-input-fidelity cookbook](https://developers.openai.com/cookbook/examples/generate_images_with_high_input_fidelity), [gpt-image-1.5 prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide), [OpenAI Agents SDK image_generator.py](https://github.com/openai/openai-agents-python/blob/main/examples/tools/image_generator.py), [Gemini image generation docs](https://ai.google.dev/gemini-api/docs/image-generation), [Gemini Book_illustration notebook](https://github.com/google-gemini/cookbook/blob/main/examples/Book_illustration.ipynb), [Gemini consistent-imagery codelab](https://codelabs.developers.google.com/gemini-consistent-imagery-notebook), [Nano Banana 2 build blog](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-nano-banana-2/), [BFL Kontext](https://bfl.ai/blog/flux-1-kontext), [Vercel ai-sdk-image-generator](https://github.com/vercel-labs/ai-sdk-image-generator), [AI SDK image generation docs](https://ai-sdk.dev/docs/ai-sdk-core/image-generation), [fal.ai review](https://www.buildfastwithai.com/ai-tools/fal-ai), [NanoThumbnail](https://github.com/yoanbernabeu/NanoThumbnail), [ad creative guide](https://adlibrary.com/posts/guide-to-ai-ad-creative-generation), [creative QA pipeline](https://medium.com/madailab/building-an-ai-powered-creative-qa-system-combining-heim-metrics-with-llm-based-marketing-judgment-0c8b14be7c7b), [VisionDirector](https://arxiv.org/html/2512.19243), [15 Nano Banana use cases](https://developersjourney.substack.com/p/15-insane-use-cases-of-google-nano-banana), [GPT Image 2 storyboards](https://www.nemovideo.com/blog/gpt-image-2-storyboard), [PetaPixel on Figma/Adobe/Canva](https://petapixel.com/2025/04/24/chatgpts-popular-new-image-generator-coming-to-adobe-figma-canva-and-more/).
