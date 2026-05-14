import { glob } from "astro/loaders"
// `z` is re-exported from "astro:content" with a deprecation hint pointing at
// the `zod` package directly — but `zod` isn't a workspace dep here, and
// Starlight's `docsSchema({ extend })` doesn't currently take a typed
// `SchemaContext`-style callback. The re-export still works.
// eslint-disable-next-line @typescript-eslint/no-deprecated
import { defineCollection, z } from "astro:content"
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
    schema: docsSchema({
      extend: z.object({
        /**
         * Repo-relative path to a folder that should be linked from the page
         * as a "View on GitHub" chip in the title row. Example:
         * `recipes/voice-loop`.
         */
        source: z.string().optional(),
        /**
         * Phosphor (`react-icons/pi`) component name to render next to the
         * H1 — e.g. `PiMicrophone`. The name must be registered in the
         * `iconMap` in `components/PageTitle.astro`.
         */
        icon: z.string().optional(),
      }),
    }),
  }),
}
