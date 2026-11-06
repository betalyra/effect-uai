import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  server: {
    // Follow the `link:`ed packages out of this folder.
    fs: { allow: ["../.."] },
  },
  plugins: [tanstackStart(), viteReact()],
})
