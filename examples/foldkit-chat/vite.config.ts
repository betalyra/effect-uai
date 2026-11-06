import { defineConfig } from "vite"

// server.ts serves the chat on :3001; the page proxies to it.
export default defineConfig({
  server: {
    proxy: { "/api": "http://localhost:3001" },
    // Follow the `link:`ed packages out of this folder.
    fs: { allow: ["../.."] },
  },
})
