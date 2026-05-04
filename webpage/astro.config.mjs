import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import mdx from "@astrojs/mdx"
import react from "@astrojs/react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    react(),
    starlight({
      title: "effect-uai",
      description: "Low-level primitives for AI agents in Effect.",
      customCss: ["./src/styles/tailwind.css", "./src/styles/custom.css"],
      head: [
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
      ],
      components: {
        ThemeSelect: "./src/components/ThemeSelect.astro",
        Hero: "./src/components/Hero.astro",
        Footer: "./src/components/Footer.astro",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/betalyra/effect-uai",
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
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "The loop primitive", slug: "concepts/loop" },
            { label: "Items and turns", slug: "concepts/items-and-turns" },
            { label: "Tools and toolkits", slug: "concepts/tools" },
            { label: "Language model", slug: "concepts/language-model" },
          ],
        },
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
          items: [
            { label: "Overview", slug: "recipes" },
            { label: "Tool call approval", slug: "recipes/tool-call-approval" },
            { label: "Streaming tool output", slug: "recipes/streaming-tool-output" },
            {
              label: "Streaming structured output",
              slug: "recipes/streaming-structured-output",
            },
            {
              label: "Multi-model fallback",
              slug: "recipes/multi-model-fallback",
            },
            { label: "Auto-compaction", slug: "recipes/auto-compaction" },
            { label: "Pause and resume", slug: "recipes/pause-resume" },
            { label: "Mid-stream abort", slug: "recipes/mid-stream-abort" },
            { label: "Agentic loop", slug: "recipes/agentic-loop" },
            { label: "Modify output stream", slug: "recipes/modify-output-stream" },
            { label: "Model retry", slug: "recipes/model-retry" },
            {
              label: "Multi-model compare",
              slug: "recipes/multi-model-compare",
            },
            { label: "Model council", slug: "recipes/model-council" },
          ],
        },
      ],
    }),
    mdx(),
  ],
})
