import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import path from "node:path";

const hostRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostRoot, "..");

// Host SPA — served on :5173 in dev/test. Embeds one cross-origin <iframe>
// per vh-solara server (iframe content lives on :5174, see vite.iframe.config.ts).
//
// FOLDED BUILD (VITE_HOST_FOLDED=1): when the host shell is built to be embedded
// inside the vh-solara Go binary (served at `/` alongside the single-server SPA
// at `/app`), its assets are namespaced under `/host/` so they do not collide
// with the single-server SPA's root-level `/assets/` (the single-server SPA is
// built with base "/" and is intentionally UNCHANGED). The Go server serves
// `/host/*` from the embedded host-dist FS. Every other build (dev, preview, the
// e2e lanes) leaves VITE_HOST_FOLDED unset → base "/" → unaffected.
const foldedBase = process.env.VITE_HOST_FOLDED ? "/host/" : undefined;

export default defineConfig({
  plugins: [solid()],
  base: foldedBase,
  // The dev server MUST be reachable from the cross-origin iframe's parent.
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    // The host theme system imports the SHARED theme catalog from the web/
    // tree (src/theme.ts → ../../web/src/themeCatalog.ts). Vite's default
    // fs.allow is the detected workspace root, and this repo has NO workspace
    // markers (no root package.json/workspaces, no pnpm-workspace.yaml — .git
    // is explicitly NOT a marker in Vite's ROOT_FILES), so the default allow
    // list collapses to host-web/ alone and the dev server would 403 the
    // cross-tree import. Allow the repo root explicitly (dev server only;
    // `vite build` reads from disk and is unaffected).
    fs: {
      allow: [repoRoot],
    },
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
