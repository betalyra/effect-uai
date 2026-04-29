import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"

export default defineConfig({
  integrations: [
    starlight({
      title: "effect-uai",
      description: "Low-level primitives for AI agents in Effect.",
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
          autogenerate: { directory: "start" },
        },
        {
          label: "Concepts",
          autogenerate: { directory: "concepts" },
        },
        {
          label: "Recipes",
          autogenerate: { directory: "recipes" },
        },
      ],
    }),
  ],
})
