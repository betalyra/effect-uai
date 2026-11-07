import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  server: {
    // Off the usual dev ports, so it runs next to other apps (and the other examples).
    port: 4310,
    // Follow the `link:`ed packages out of this folder.
    fs: { allow: ["../.."] },
  },
  plugins: [tanstackStart(), viteReact()],
})
