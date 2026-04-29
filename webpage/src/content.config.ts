import { glob } from "astro/loaders"
import { defineCollection } from "astro:content"
import { docsSchema } from "@astrojs/starlight/schema"

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "..",
      pattern: ["docs/**/*.{md,mdx}", "recipes/*/README.md"],
      generateId: ({ entry }) => {
        if (entry.startsWith("docs/")) {
          const id = entry.replace(/^docs\//, "").replace(/\.(md|mdx)$/, "")
          return id === "index" ? "index" : id.replace(/\/index$/, "")
        }
        return entry.replace(/\/README\.md$/, "")
      },
    }),
    schema: docsSchema(),
  }),
}
