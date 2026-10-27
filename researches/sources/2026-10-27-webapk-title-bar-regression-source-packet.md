# Source packet — Chrome Android WebAPK title-bar regression investigation (pass 1, 2026-10-27)

## Symptom

Installed VHSolara PWA on Chrome Android showed a title bar (page title
"VHSolara · Host" + origin `bason.vc.libvh.dev` + three-dot menu) immediately
after the 2026-10-27 Chrome update; previously the app filled the screen.

## Repo facts (git-verified)

- `web/public/manifest.webmanifest` history is exactly 3 commits:
  - `48bb9bd` 2026-06-18 (v1.0.0) — created.
  - `0a3e134` + `9214931` 2026-07-21 — icons/screenshots/protocol
    handler/related_applications only.
  - Identity fields byte-identical since creation: name "VHSolara",
    `start_url "/"`, `scope "/"`, `display "standalone"`, **no `id` member**
    (→ computed identity = origin root).
- `web/index.html:14` links the manifest (SPA side).
- `host-web/index.html:9` has title "VHSolara · Host" and **NO manifest link**.
- `pkg/web/static_assets.go:354-385` serves the host index verbatim at `/`
  (production `hostShellAtRoot`); `:325-335` serves `/manifest.webmanifest`
  from the web dist FS (origin root).
- Fold timeline: the fold landed `f461094` 2026-08-09; first tagged in the
  folded posture `v1.61.0` 2026-08-23 → defect window ~2 months at symptom
  time. No manifest/host/fold change after `v1.77.1` (2026-10-12).
- SW layer (`host-web/src/swNarrow.ts` scope `/app`; `web/src/pwa.ts` root
  scope) causally irrelevant to browser UI chrome.

## Web findings pass 1 (retrieved 2026-10-27)

- Chrome Android `157.0.8103.14` hit early-stable Oct 23 2026
  (chromereleases.googleblog.com); 2-week release cadence.
- Display mode is baked into the WebAPK at install; manifest-less in-scope
  pages do not demote the stored display (progressivewebapps.com manifest
  docs, Sep 2026, citing `ShortcutInfo::UpdateFromManifest`).
- WebAPK update checks fire on launch (~1–3d, 30d relaxed) and require a
  main-frame in-scope page linking a valid installable manifest; a missing
  link makes the check a no-op (WebApkUpdateManager / WebApkUpdateDataFetcher).
- minimal-ui on Chrome Android = title bar with the current `<title>` +
  origin + small menu; out-of-scope / CCT = origin + X close button
  (web.dev Learn PWA / progressivewebapps.com).
- No mass "PWA title bar after update" reports found in Oct 2026.

## Hypothesis outcomes

- **H1 per-document display derivation** — contradicted by docs; superseded.
- **H2 update re-verification demotion** — killed by device evidence: the
  WebAPK was intact and had never been updated.
- **H3 stored scope mismatch** — no repo-side source (identity byte-identical
  across all eras); UI mismatch (no X button).
- **H4 repo change near the date** — evidence-against.
- **H5 pure Chrome regression** — no mass reports.
- **H6 shortcut** — killed by `chrome://webapks` showing a real WebAPK.

## Contradiction audit vs external preliminary findings

Claims 1–6 confirmed as stated, **except** the implied causality of the
missing manifest link: it starves updates / enables the DIY mint; it does not
by itself demote the stored display mode.
