import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

// During `npm run dev`, proxy the daemon's API. Point VH_DAEMON at a running
// `vh-solara client-daemon --web=vh` web port.
const target = process.env.VH_DAEMON || "http://127.0.0.1:8090";
const webRoot = path.dirname(fileURLToPath(import.meta.url));

// Stamp a unique build id into the (verbatim-copied) service worker so its bytes
// change every build → browsers detect a new SW → the app shows "update available".
function swBuildId(): Plugin {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return {
    name: "vh-sw-build-id",
    closeBundle() {
      const sw = path.resolve(webRoot, "dist-build/sw.js");
      if (existsSync(sw)) {
        writeFileSync(sw, readFileSync(sw, "utf8").replace(/__BUILD_ID__/g, id));
      }
    },
  };
}

export default defineConfig({
  plugins: [solid(), swBuildId()],
  build: {
    // Emit into a gitignored STAGING dir (web/dist-build), NOT the Go embed
    // source (pkg/web/dist). Embed-producing targets (`make build`/`install`/
    // `fixtures`, the release workflow) materialize (copy) the staged bundle
    // into pkg/web/dist right before `go build`. This keeps `make web` from
    // clobbering the tracked fallback placeholder pkg/web/dist/index.html.
    outDir: "dist-build",
    emptyOutDir: true,
    target: "es2020",
  },
  server: {
    proxy: {
      "/vh": { target, changeOrigin: true },
      "/oc": { target, changeOrigin: true },
    },
  },
});
