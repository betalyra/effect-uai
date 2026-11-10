import { defineConfig } from "vite"

// The page on :4320, server.ts on :4325 (off the usual dev ports, Astro's 4321 included);
// the page proxies to it.
export default defineConfig({
  server: {
    port: 4320,
    proxy: { "/api": "http://localhost:4325" },
    // Follow the `link:`ed packages out of this folder.
    fs: { allow: ["../.."] },
  },
})
