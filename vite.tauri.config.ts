// Tauri build config — closely mirrors vite.config.ts but adds
// clearScreen: false so Tauri CLI output remains visible.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    base: './',
    clearScreen: false,
    server: {
      port: 3000,
      strictPort: true,
    },
    resolve: {
      tsconfigPaths: true,
    },
  },
  nitro: {
    prerender: {
      routes: ["/"],
      crawlLinks: true,
    },
  } as any,
});