import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
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

// Folded-posture SPA entry preload (page-load-perf Waterfall P2).
//
// PROBLEM (measured; tmp/agent-runs/page-load-perf/raw/bbundle-after-cold-8):
// in the folded topology the host shell at `/` boots the SPA panes at `/app`,
// and the SPA's hashed entry assets (/assets/index-*.js|css) are only
// discovered when the first pane document arrives — strictly AFTER the host
// shell, the host's own assets, and SW activation (cold-8: host assets on the
// wire 226-459ms; SPA entry assets not requested until ~923ms; the pane-side
// JS serves complete 1264-1342ms). That serial leg is pure transport delay.
//
// FIX: issue the SPA entry fetches from the host shell itself, in parallel
// with the host's own assets. The asset URLs are content-hashed and only
// exist after the SPA build, so they CANNOT live statically in this
// file — but every embed-producing pipeline builds web/ BEFORE host-web/
// (`make embed-materialize`, harness/build.sh, folded-restore-run.sh), so at
// THIS build's time the staged SPA shell web/dist-build/index.html already
// names them. Mirror its entry tags as hints injected into the built host
// shell:
//   <script type="module" crossorigin src=X>   -> <link rel="modulepreload" crossorigin href=X>
//   <link rel="stylesheet" crossorigin href=Y> -> <link rel="preload" as="style" crossorigin href=Y>
// The immutable assets then land in the HTTP cache during the host-asset
// window, and the pane SW's cache-first fetch() — which consults the HTTP
// cache, as warm receipts prove (spa_asset fromCache=true in
// bbundle-after-warm-8) — serves them locally instead of over the wire.
//
// GATES (deliberately narrow):
//   - build only (apply: "build"): the dev/preview lanes serve a different
//     topology (no same-origin /assets) and must not see phantom hints.
//   - VITE_HOST_FOLDED only: the hints target same-origin root-level
//     /assets/*, which exists only in the folded single-server posture.
//   - missing/unparseable staged shell -> no-op: the sole failure mode is a
//     browser preload of a URL the server does not know (a 404 the real
//     fetch path ignores); boot correctness never depends on the hints.
function spaEntryPreload(): Plugin {
  const stagedSpaShell = (): string | null => {
    try {
      return readFileSync(
        path.resolve(repoRoot, "web/dist-build/index.html"),
        "utf8",
      );
    } catch {
      return null; // web/ not staged yet (dev / standalone host builds) — no-op
    }
  };
  const entryHintTags = (): string[] => {
    const shell = stagedSpaShell();
    if (!shell) return [];
    const hints: string[] = [];
    for (const m of shell.matchAll(/<script\b[^>]*\btype="module"[^>]*>/gi)) {
      const src = /\ssrc="([^"]+)"/.exec(m[0]);
      if (src && src[1].startsWith("/")) {
        hints.push(`<link rel="modulepreload" crossorigin href="${src[1]}" />`);
      }
    }
    for (const m of shell.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)) {
      const href = /\shref="([^"]+)"/.exec(m[0]);
      if (href && href[1].startsWith("/")) {
        hints.push(`<link rel="preload" as="style" crossorigin href="${href[1]}" />`);
      }
    }
    return hints;
  };
  return {
    name: "vh-spa-entry-preload",
    apply: "build",
    transformIndexHtml: {
      // "post": land AFTER vite's own host asset tags, so the host's entry
      // stays first in document order (both are parse-discovered together).
      order: "post",
      handler(html) {
        if (!process.env.VITE_HOST_FOLDED) return html;
        const hints = entryHintTags();
        if (hints.length === 0) return html;
        const block = [
          `    <!-- vh-spa-entry-preload: fetch the single-server SPA entry
         assets in parallel with host assets (folded posture only).
         Generated from web/dist-build/index.html at build time — the
         content-hashed URLs are only knowable then; do not edit by hand. -->`,
          ...hints.map((h) => `    ${h}`),
        ].join("\n");
        return html.replace("</head>", `${block}\n  </head>`);
      },
    },
  };
}

export default defineConfig({
  plugins: [solid(), spaEntryPreload()],
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
