import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1425,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1426 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    cssMinify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  test: {
    // Node by default, because most of what is worth testing here is pure.
    // The chart tests need a DOM and say so with a `@vitest-environment`
    // docblock of their own rather than making every test pay for jsdom.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
