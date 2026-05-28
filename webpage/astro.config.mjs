import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import mdx from "@astrojs/mdx"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import starlightLlmsTxt from "starlight-llms-txt"
import tailwindcss from "@tailwindcss/vite"

const stubPagePattern = /\/(reranking|realtime|image-generation|video-generation)\/$/

const isVercelProduction = process.env.VERCEL_ENV === "production"

const plausibleHead = isVercelProduction
  ? [
      {
        tag: "script",
        attrs: {
          async: true,
          src: "https://plausible.io/js/pa-yDUj4fz1BbZ6quQM9sZXf.js",
        },
      },
      {
        tag: "script",
        content:
          "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()",
      },
    ]
  : []

export default defineConfig({
  site: "https://effect-uai.betalyra.com",
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ["@takumi-rs/core"],
    },
    ssr: {
      external: ["@takumi-rs/core"],
    },
  },
  integrations: [
    react(),
    sitemap({
      filter: (page) => !stubPagePattern.test(new URL(page).pathname),
    }),
    starlight({
      title: "effect-uai",
      description: "Low-level primitives for AI agents in Effect.",
      logo: {
        src: "./src/assets/effect-uai-logo.svg",
        replacesTitle: true,
      },
      plugins: [
        starlightLlmsTxt({
          projectName: "effect-uai",
          description:
            "Low-level Effect-TS primitives for building AI agents: streaming agent loops, tool calling, structured output, multi-provider (OpenAI, Anthropic, Google Gemini), embeddings, and speech.",
          rawContent: true,
          exclude: ["reranking", "realtime", "image-generation", "video-generation"],
        }),
      ],
      customCss: ["./src/styles/tailwind.css", "./src/styles/custom.css"],
      head: plausibleHead,
      components: {
        Head: "./src/components/Head.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        Hero: "./src/components/Hero.astro",
        Footer: "./src/components/Footer.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/betalyra/effect-uai",
        },
        {
          icon: "x.com",
          label: "X (Twitter)",
          href: "https://x.com/effectuai_sdk",
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Why effect-uai", slug: "start/why" },
            { label: "Installation", slug: "start/installation" },
            { label: "Quickstart", slug: "start/getting-started" },
            { label: "Basic usage", slug: "recipes/basic-usage" },
            { label: "Structured output", slug: "recipes/structured-output" },
            { label: "Basic embedding", slug: "recipes/basic-embedding" },
            { label: "Recipes", slug: "recipes" },
            { label: "Skills", slug: "skills" },
          ],
        },
        {
          label: "Concepts",
          items: [{ label: "Items and turns", slug: "concepts/items-and-turns" }],
        },
        {
          label: "Language models",
          items: [
            { label: "Overview", slug: "concepts/language-model" },
            { label: "The loop primitive", slug: "concepts/loop" },
            { label: "Tools and toolkits", slug: "concepts/tools" },
            {
              label: "Providers",
              items: [
                { label: "Responses / OpenAI", slug: "providers/responses" },
                { label: "Google Gemini", slug: "providers/gemini" },
                { label: "Anthropic", slug: "providers/anthropic" },
              ],
            },
            {
              label: "Recipes",
              collapsed: true,
              items: [
                {
                  label: "Tool call approval",
                  slug: "recipes/tool-call-approval",
                },
                {
                  label: "Streaming tool output",
                  slug: "recipes/streaming-tool-output",
                },
                {
                  label: "Streaming structured output",
                  slug: "recipes/streaming-structured-output",
                },
                {
                  label: "Multi-model fallback",
                  slug: "recipes/multi-model-fallback",
                },
                { label: "Model escalation", slug: "recipes/model-escalation" },
                { label: "Auto-compaction", slug: "recipes/auto-compaction" },
                { label: "Pause and resume", slug: "recipes/pause-resume" },
                { label: "Mid-stream abort", slug: "recipes/mid-stream-abort" },
                { label: "Sleeper agent", slug: "recipes/sleeper-agent" },
                { label: "Agentic loop", slug: "recipes/agentic-loop" },
                {
                  label: "Modify output stream",
                  slug: "recipes/modify-output-stream",
                },
                { label: "Model retry", slug: "recipes/model-retry" },
                {
                  label: "Multi-model compare",
                  slug: "recipes/multi-model-compare",
                },
                { label: "Model council", slug: "recipes/model-council" },
              ],
            },
          ],
        },
        {
          label: "Embeddings",
          items: [
            { label: "Overview", slug: "embeddings" },
            { label: "Multimodal embedding", slug: "embeddings/multimodal" },
            { label: "Multivector embedding", slug: "embeddings/multivector" },
            {
              label: "Providers",
              items: [
                {
                  label: "Responses / OpenAI",
                  slug: "embeddings/providers/responses",
                },
                { label: "Google Gemini", slug: "embeddings/providers/gemini" },
                { label: "Jina", slug: "embeddings/providers/jina" },
              ],
            },
          ],
        },
        {
          label: "Speech",
          items: [
            { label: "Overview", slug: "speech" },
            { label: "Transcription", slug: "speech/transcription" },
            { label: "Synthesis", slug: "speech/synthesis" },
            {
              label: "Providers",
              items: [
                { label: "OpenAI", slug: "speech/providers/openai" },
                { label: "ElevenLabs", slug: "speech/providers/elevenlabs" },
                { label: "Google Gemini", slug: "speech/providers/gemini" },
                { label: "Inworld", slug: "speech/providers/inworld" },
              ],
            },
            {
              label: "Recipes",
              collapsed: true,
              items: [
                {
                  label: "Basic transcription",
                  slug: "recipes/basic-transcription",
                },
                {
                  label: "Basic speech synthesis",
                  slug: "recipes/basic-speech-synthesis",
                },
                {
                  label: "Streaming transcription",
                  slug: "recipes/streaming-transcription",
                },
                {
                  label: "Streaming synthesis",
                  slug: "recipes/streaming-synthesis",
                },
                { label: "Voice loop", slug: "recipes/voice-loop" },
              ],
            },
          ],
        },
        {
          label: "Music generation",
          items: [
            { label: "Overview", slug: "music-generation" },
            {
              label: "Providers",
              items: [
                {
                  label: "Google Lyria",
                  slug: "music-generation/providers/gemini",
                },
                {
                  label: "ElevenLabs Music",
                  slug: "music-generation/providers/elevenlabs",
                },
              ],
            },
            {
              label: "Recipes",
              collapsed: true,
              items: [
                {
                  label: "Basic music generation",
                  slug: "recipes/basic-music-generation",
                },
                {
                  label: "Radio station",
                  slug: "recipes/radio-station",
                },
              ],
            },
          ],
        },
        {
          label: "Sandboxes",
          items: [
            { label: "Overview", slug: "sandboxes" },
            {
              label: "Providers",
              items: [
                { label: "Microsandbox", slug: "sandboxes/providers/microsandbox" },
                { label: "Deno Sandbox", slug: "sandboxes/providers/deno" },
              ],
            },
            {
              label: "Recipes",
              collapsed: true,
              items: [{ label: "Run, fix, repeat", slug: "recipes/sandbox-code-interpreter" }],
            },
          ],
        },
        {
          label: "Migrations",
          collapsed: true,
          items: [
            { label: "Overview", slug: "migrations" },
            { label: "Migrating to 0.6", slug: "migrations/v0-6" },
            { label: "Migrating to 0.5", slug: "migrations/v0-5" },
            { label: "Migrating to 0.4", slug: "migrations/v0-4" },
            { label: "Migrating to 0.3", slug: "migrations/v0-3" },
          ],
        },
        {
          label: "Coming soon",
          collapsed: true,
          items: [
            {
              label: "Reranking",
              slug: "reranking",
              badge: { text: "Soon", variant: "note" },
            },
            {
              label: "Realtime",
              slug: "realtime",
              badge: { text: "Soon", variant: "note" },
            },
            {
              label: "Image generation",
              slug: "image-generation",
              badge: { text: "Soon", variant: "note" },
            },
            {
              label: "Video generation",
              slug: "video-generation",
              badge: { text: "Soon", variant: "note" },
            },
          ],
        },
      ],
    }),
    mdx(),
  ],
})
