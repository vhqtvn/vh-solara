import { expect, test } from "@playwright/test";

// =============================================================================
// FOLDED-POSTURE MANIFEST-LINK e2e — the WebAPK identity/update anchor.
//
// DEFECT this pins (2026-10-27): the folded production start_url document —
// the HOST shell the binary serves at `/` — had NO <link rel="manifest">.
// Chrome Android therefore minted the operator's installed app as a
// manifest-less DIY WebAPK (empty Manifest URL, stored display `minimal-ui`),
// which current Chrome renders with an unwanted title bar. The fix links the
// existing single-server SPA manifest at the origin root; Chrome's WebAPK
// update path (WebApkUpdateManager / WebApkUpdateDataFetcher) can then adopt
// the manifest into the existing WebAPK from a MAIN-FRAME in-scope load and
// re-mint standalone in place.
//
// Why THIS lane (lane 9) and not the dev lanes: the invariant is about the
// BUILT folded artifact. `host-web/vite.config.ts` sets base '/host/' when
// VITE_HOST_FOLDED=1, and Vite rewrites root-absolute PUBLIC-file hrefs in
// index.html (the icons become /host/icon.svg). If /manifest.webmanifest
// were ever namespaced to /host/manifest.webmanifest the link would 404 on
// the real binary (nothing serves /host/manifest.webmanifest) and WebAPK
// adoption would silently no-op. Only this lane boots the real folded
// binary, so only here can the served-document href be pinned.
//
// Production-safe like the sibling folded specs: DOM + request assertions
// only (no DEV bridges exist in the folded build).
// =============================================================================

test.describe.serial("folded-posture host manifest link", () => {
  test("folded root document links /manifest.webmanifest root-absolute (not /host/)", async ({
    page,
  }) => {
    // Raw HTML the REAL binary serves at `/` — assert the href AT THE
    // SOURCE, so a future Vite rewrite (e.g. someone adds the manifest to
    // host-web/public/, making it a base-prefixed public file) fails HERE
    // with the literal offending URL, not as a mysterious adoption no-op.
    const res = await page.request.get("/");
    expect(res.status(), "folded host shell served at /").toBe(200);
    const html = await res.text();
    const tag = /<link\b[^>]*\brel="manifest"[^>]*>/.exec(html);
    expect(tag, 'served host shell has a <link rel="manifest">').toBeTruthy();
    const href = (/\shref="([^"]+)"/.exec(tag![0]) ?? [])[1];
    expect(href, "manifest href is root-absolute, NOT namespaced under /host/").toBe(
      "/manifest.webmanifest",
    );
  });

  test("folded root document: DOM-resolved manifest href + servable standalone manifest", async ({
    page,
  }) => {
    // The live document: the link element exists and its RESOLVED absolute
    // href is <origin>/manifest.webmanifest — what Chrome's main-frame
    // fetcher would observe.
    await page.goto("/");
    const resolved = await page.evaluate(() =>
      (document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null)?.href ?? null,
    );
    expect(resolved, "link[rel=manifest] present in the loaded document").toBeTruthy();
    const origin = new URL(page.url()).origin;
    expect(resolved).toBe(`${origin}/manifest.webmanifest`);

    // The load-bearing invariant for WebAPK adoption: the linked manifest is
    // actually served (200) and declares the standalone identity the
    // re-mint needs (display standalone, root scope + start_url → computed
    // id = origin root, matching the stored DIY WebAPK id).
    const m = await page.request.get("/manifest.webmanifest");
    expect(m.status(), "GET /manifest.webmanifest → 200").toBe(200);
    expect(m.headers()["content-type"] ?? "", "served as a manifest").toContain("manifest");
    const manifest = await m.json();
    expect(manifest.display, "display standalone (re-mint away from minimal-ui)").toBe(
      "standalone",
    );
    expect(manifest.scope, "root scope (computed id = origin root)").toBe("/");
    expect(manifest.start_url, "start_url at origin root").toBe("/");
  });
});
