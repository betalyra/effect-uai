import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"

export default defineConfig({
  integrations: [
    starlight({
      title: "effect-uai",
      description: "Low-level primitives for AI agents in Effect.",
      customCss: ["./src/styles/custom.css"],
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
          items: [{ label: "Installation", slug: "start/installation" }],
        },
        {
          label: "Concepts",
          items: [{ label: "The loop primitive", slug: "concepts/loop" }],
        },
        {
          label: "Recipes",
          items: [
            { label: "Overview", slug: "recipes" },
            {
              label: "Multi-model fallback",
              slug: "recipes/multi-model-fallback",
            },
            { label: "Auto-compaction", slug: "recipes/auto-compaction" },
            { label: "Pause and resume", slug: "recipes/pause-resume" },
            { label: "Mid-stream abort", slug: "recipes/mid-stream-abort" },
          ],
        },
      ],
    }),
  ],
})
