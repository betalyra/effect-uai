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
      components: {
        ThemeSelect: "./src/components/ThemeSelect.astro",
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
            { label: "Installation", slug: "start/installation" },
            { label: "Getting started", slug: "start/getting-started" },
          ],
        },
        {
          label: "Concepts",
          items: [{ label: "The loop primitive", slug: "concepts/loop" }],
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
            { label: "Basic usage", slug: "recipes/basic-usage" },
            {
              label: "Multi-model fallback",
              slug: "recipes/multi-model-fallback",
            },
            { label: "Auto-compaction", slug: "recipes/auto-compaction" },
            { label: "Pause and resume", slug: "recipes/pause-resume" },
            { label: "Mid-stream abort", slug: "recipes/mid-stream-abort" },
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
