import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Host SPA — served on :5173 in dev/test. Embeds one cross-origin <iframe>
// per vh-solara server (iframe content lives on :5174, see vite.iframe.config.ts).
export default defineConfig({
  plugins: [solid()],
  // The dev server MUST be reachable from the cross-origin iframe's parent.
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  preview: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
  },
});
