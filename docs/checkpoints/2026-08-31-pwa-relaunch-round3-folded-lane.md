# PWA relaunch layout loss — round 3 (folded lane + diag round 2 + impossibility proof)

Date: 2026-08-31 · Scope: host-web layout persistence / folded posture · Build under test: `ede90df`

## Outcome in one paragraph

The folded-posture restore is **proven correct at HEAD** by a new real-binary e2e
lane (LANE 9, `host-web/tests/folded-e2e/`), and the operator's diag paste is
**provably not producible by HEAD code**: `seed` with `readSource=v3` is
structurally impossible (`store.ts`: `seedWorkspaceId = hadSavedStateAtInit() ?
null : …` makes seeding unreachable whenever a blob was read, and the seed
event's own `initWs:["ws-1"]` proves `initBlob` was non-null in the emitting
module instance). The deployed device bundle's seed path therefore diverged from
the source under diagnosis (stale/mid-slice build). Per the round-3 STOP
discipline, no guess-patch was made to the restore path; instead diag round 2 +
the folded lane arm the next operator reproduction. The lane earned its keep
immediately: it caught (pre-ship) a TDZ module-kill introduced BY this slice's
diag code — see Findings.

## Findings

- **Allowlist suspect DISMISSED (fact, code citation)**: with no `VITE_SERVERS`
  the folded build has `hasRealFleetEnv() === false` → `validRestoreIds` builds
  `fleetOrigins = null` → only the http/https protocol check runs
  (`layoutPersistence.ts` validRestoreIds). The operator's
  `http://<lan-ip>:8765/app?…` pane URLs pass. Dev-vs-folded divergence in URL
  validation does not exist.
- **materialize/staged-slot suspects DISMISSED (fact, audit)**:
  `materializeSavedLayout` never throws and always returns a tree (0-extent
  tolerated; degenerate fractions → equal shares); staged runtime slots are
  keyed by workspace id and consumed-on-read — a stale slot cannot shadow the
  initBlob for an existing workspace.
- **Second-window overwrite vector NOT real at HEAD (fact, tested)**: folded
  lane test 3 boots a second page at `/` over a valid blob — no seed, no
  clobber. `installLayoutSaver` is installed after cold init, so a booting
  seed/restore schedules no save; the ~130ms-after-boot flush in the operator's
  ring is the restored/seeded pane's SPA `route` message → `scheduleSave`
  (reproduced in every folded-lane boot).
- **Operator's `seed readSource=v3` impossible at HEAD (fact, structural)** —
  see paragraph above. Consequence: the device's layout loss AND its blob
  clobbering are both explained by a diverged deployed bundle whose
  restore-failure path seeded (a seed boot flushes its fresh layout over the
  operator's blob via the same route-message save path).
- **15ms flush→read anomaly (bounded, inference)**: not a kill+relaunch. Either
  a device clock artifact at the kill boundary, or a second window (ring is
  shared storage; events from two windows interleave in one ring). Both are
  consistent with the impossibility proof; diag round 2 (`diagv` stamp +
  restore events) will disambiguate on the next paste.
- **TDZ module-kill caught by the new lane (fact, fixed in-slice)**: diag
  round 2 initially declared `const RAW_PREFIX_CAP` below the init-time
  `readBlobWithSource()` call — on relaunch WITH a blob, `raw.slice(0,
  RAW_PREFIX_CAP)` threw `ReferenceError` (minified `_n`) at module init,
  killing the whole host graph: no render, no read event, root empty — a
  total "layout lost". Fresh contexts returned before the reference, so boot 1
  always worked — exactly the relaunch-only shape. Fixed by hoisting the const
  above the init read (declaration-site comment explains the TDZ rationale).
  This never shipped; it validates the lane's reason to exist.

## What landed

- `host-web/src/dockview/layoutDiag.ts` — `restore` event kind, `DIAG_VERSION=2`.
- `host-web/src/dockview/layoutPersistence.ts` — diag round 2: `restore` events
  (outcome restored|failed; reasons `blob-null | no-entry | layout-null |
  invalid-shape | pruned-all:<ids> | repair-empty | exception:<msg>`), seed
  `blobPrefix` (~200-char incoming-blob fingerprint, corrupt-JSON bytes
  included), read `diagv` stamp; read-path refactor to a detailed-repair
  result (public `loadRepairedWorkspaceLayout` API unchanged); RAW_PREFIX_CAP
  TDZ fix.
- `host-web/playwright.folded.config.ts` + `host-web/tests/folded-e2e/folded-restore.spec.ts`
  + `host-web/scripts/folded-restore-run.sh` + `make test-host-web-folded` —
  LANE 9: real binary, folded host at `/`, same-origin `/app` panes, no Vite
  dev server. 3 crux tests: self-seed save → clean relaunch restores (no
  seed); planted operator-shaped blob (2 panes, `/app` origins, routes)
  restores; second window never clobbers.
- `host-web/tests/e2e/kill-relaunch-persistence.spec.ts` — dev-posture round-2
  diag test (fresh-boot `failed/blob-null` + `diagv` + empty seed fingerprint;
  reload `restored` with `panes:4`; all-poison blob → `pruned-all:<ids>` and
  NO seed).
- `.vh-agent-harness/AGENTS.mission.md` — lanes list 8→9 (rendered AGENTS.md
  regenerates on the next `vh-agent-harness update`).

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Folded restore works at HEAD (real binary, clean relaunch, no seed) | `cd host-web && npx playwright test --config=playwright.folded.config.ts --project=chromium` → 3 passed | yes |
| Planted operator-shaped blob restores both panes + routes | same lane, test 2 (`restore outcome=restored panes=2`, srcs deep-linked) | yes |
| Second window does not clobber a valid blob | same lane, test 3 (no seed, blob 1 panel after settle) | yes |
| Dev lane green incl. new round-2 diag test | `npm --prefix host-web run test:e2e` → 459 passed / 0 failed / 14 env-gated skips | yes |
| Preview (production-build shell) green | `npm --prefix host-web run test:e2e:preview` → 8 passed | yes |
| Typecheck clean | `npm --prefix host-web run typecheck` → clean | yes |
| `seed readSource=v3` impossible at HEAD | structural: `store.ts:152` + seed event's own `initWs` derivation | yes |
| TDZ fix verified | probe ring: `read v3 → restore restored panes:1` (was: no read event, empty root) | yes |

## Contradictions

- The operator's ring vs HEAD semantics (impossibility proof) — resolved as a
  diverged deployed bundle, not a code bug at HEAD. Unverifiable from here;
  the `diagv` stamp on the next paste settles it (absent/old stamp ⇒ stale
  bundle proven).

## Next operator step (one reproduction)

Reproduce once on-device with the NEXT build, then Settings → "Copy layout
diagnostics" and paste. Read the paste in this order: (1) `read.diagv` —
absent/old ⇒ stale bundle; (2) a `seed` whose `readSource` is v3/v2/hash ⇒ the
diverged-bundle path again (should now be impossible); (3) `restore` events —
`failed` + reason pins the nulling step exactly; (4) `seed.blobPrefix` shows
the incoming bytes verbatim.
