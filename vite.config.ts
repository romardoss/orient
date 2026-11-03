import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // The generated symbol library is served as-is (SVG/PNG/JSON).
  publicDir: "assets",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        // the game is the main page; the map generator and symbol catalogue are side tools
        main: resolve(import.meta.dirname, "index.html"),
        generator: resolve(import.meta.dirname, "generator.html"),
        catalog: resolve(import.meta.dirname, "catalog.html"),
      },
    },
  },
  worker: { format: "es" },
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 60_000 },
} as never);
