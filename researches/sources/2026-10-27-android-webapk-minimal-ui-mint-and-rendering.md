# Source packet — Android DIY WebAPK mint, minimal-ui rendering, and in-place manifest adoption (pass 2, 2026-10-27)

## Device evidence (verbatim)

`chrome://webapks` row:

- Package: `org.chromium.webapk.ae43146322f308ad2_v2`
- Shell APK version: 189
- Version code: 1
- URI / Scope / Manifest Start URL / Manifest Id: all `https://bason.vc.libvh.dev/`
- Manifest URL: **EMPTY**
- Display Mode: **minimal-ui**
- Last Update Check: 2026-10-27 16:11 GMT+7
- Last Update Completion: **1970-01-01** (epoch)
- Update Status: Succeeded
- Owning Browser: `com.android.chrome`

## Verdict chain

1. **Repo defect** — manifest-less host `start_url` since the fold reached
   production (first tagged folded `v1.61.0`, 2026-08-23).
2. **Chrome legacy install path**
   (`InstallableCriteria::kNoManifestAtRootScope`) mints root manifest-less
   pages as `WEBAPK_DIY` — empty Manifest URL, id = start_url — with
   `ShortcutInfo::UpdateDisplayMode` forcing `kMinimalUi` when no manifest
   supplies display (`components/webapps/browser/android/shortcut_info.cc`,
   `add_to_homescreen_params.h`: "WebAPK installed from websites without PWA
   manifest").
3. **Current Chrome renders stored minimal-ui with a title bar** via
   `CustomTabsUiType.MINIMAL_UI_WEBAPP` / `WebAppHeaderLayoutCoordinator`,
   gated `WebAppHeaderUtils.isMinimalUiEnabled()`
   (`WebappIntentDataProvider.java`;
   `components/webapps/docs/android_architecture.md`). minimal-ui never
   launched on Android with the M80/81 desktop launch (chromestatus
   5680906727587840).
4. **M155/M156 wave** (155.0.8069.79 / 156.0.8078.39, stable Oct 2026)
   plausibly carried the phone rendering flip — **PARTIAL**, the flip CL is
   not primary-sourced.

Metadata is original (version code 1 + epoch completion = never re-minted;
"Succeeded" = no-op with empty manifest), so the update-day change is
rendering, not metadata.

## Issue 570202962 (read Oct 2026)

P0 "Android: 'Install' for non-installable pages is disabled > 'Install and
create shortcut'", fixed 2026-10-12, CLs
8516706/8527736/8524699/8524071/8530418/8543982, merged M155+M156. Changes
install-time classification only, not rendering.
`kAndroidInstallAnyPageAsDiyAppStopgap` default-on only on
`IS_DESKTOP_ANDROID`; the new DIY path defaults phones to standalone
(minimal-ui default is the legacy path only) — so it does not explain this
device's minimal-ui.

## In-place adoption (confirmed)

`chrome/browser/android/webapk/webapk_update_data_fetcher.cc` +
`WebApkUpdateManager.java`: a **main-frame** in-scope load linking a
`kValidManifestWithIcons` manifest whose **computed id matches the stored
id** → adopts the manifest URL; `DISPLAY_MODE_DIFFERS` is an explicit update
reason → server re-mint, Play installs in place; icon + Chrome-profile
web-app data survive. Triggers: launch-time check (1–3d throttle) +
background task (charging, unmetered, 1–23h, not foreground);
`chrome://webapks` "Update" forces it. **Main-frame only — iframes never
satisfy it** (why the host-document link is load-bearing; `/app` panes are
invisible to the fetcher).

## Migration decision

Deploy the host manifest link → launch the app → `chrome://webapks` Update →
expect Manifest URL populated, Display Mode standalone, version code 2, bar
gone.

Sequencing warning: reinstalling BEFORE the fix deploys would re-mint DIY
minimal-ui. Fallbacks in order: main-frame navigate `/app` then Update;
fresh install from a manifest-linked page (expect in-place — same
server-derived package hash; DIY→crafted upgrade is not documented, weak
evidence); uninstall/reinstall last (evidence preserved via captured dumps).

## Open device-only items

- Mint date: `adb dumpsys package org.chromium.webapk.ae43146322f308ad2_v2`
  → `firstInstallTime`.
- Exact update build: `chrome://version`.
- Render-flip milestone.
- Live adoption result.
