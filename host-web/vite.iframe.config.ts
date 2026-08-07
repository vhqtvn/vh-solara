import { defineConfig } from "vite";

// Cross-origin mock "vh-solara server" content — served on :5174 (a distinct
// origin from the host on :5173). Each pane's <iframe> points here with
// ?server=&view= query params. The page captures survival identity (mountTs +
// nonce), opens a WS echo connection (:5175), and heartbeats to its parent.
export default defineConfig({
  root: "iframe-content",
  publicDir: false,
  server: {
    port: 5174,
    strictPort: true,
    host: "127.0.0.1",
  },
  preview: {
    port: 5174,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "es2020",
    outDir: "../dist-iframe",
    emptyOutDir: true,
  },
});
