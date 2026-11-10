import { defineConfig } from "vite"

// The page on :4320, server.ts on :4321 (off the usual dev ports); the page proxies to it.
export default defineConfig({
  server: {
    port: 4320,
    proxy: { "/api": "http://localhost:4321" },
    // Follow the `link:`ed packages out of this folder.
    fs: { allow: ["../.."] },
  },
})
