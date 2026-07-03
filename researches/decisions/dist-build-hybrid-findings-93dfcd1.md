# Dist-build hybrid — findings packet for commit `93dfcd1`

- **Commit studied:** `93dfcd1` "build(web): stage SPA to dist-build, materialize into dist on embed (P1-WEB-025)"
- **Scope/type:** read-only source investigation; stable (committed code, no external recency needs); repo canon only.
- **Source policy:** committed files + git history only.
- **Studied:** residual dirty-index concern (A) + 5 advisory findings (B1–B5) surfaced in commit-review of `93dfcd1`.

## 1. Executive summary
The shipped hybrid model is sound and its headline invariant — `make web` never dirties the tracked placeholder — is mechanically enforced and CI-guarded. One finding elevates beyond "advisory": **B2**, a pre-existing **WCAG 1.4.4 zoom-lock** in `web/index.html` that the commit surfaced but did not cause (later confirmed by the operator as an INTENTIONAL product decision — documented as a comment, not changed). Two cheap hardenings (**B1** on-disk read, **B5** shared script) are worth doing now because **B1 also closes a latent gap the CI guard does not cover** — a committed-materialized `index.html` currently passes CI. A/B4/B3 are defer/drop.

## 2. Per-item analysis

### A — Residual dirty `index.html` after `make build`
**(a) What it is.** `web-materialize` (`Makefile`) does `cp -r web/dist-build/. pkg/web/dist/`, overwriting the tracked `pkg/web/dist/index.html` with the real SPA shell so `//go:embed dist` (`pkg/web/server.go:37-38`) embeds it. After `make build` the file is dirty vs HEAD. Two-layer mitigation: operator/agent restore before commit, and CI guard fails if `npm run build` dirties it.

**(b) Real severity — reassessed.** The `make web` path is well covered. **Latent gap on the `make build` path:** an operator `git commit -a` after `make build` commits the materialized `index.html`, and **CI does not catch it**:
- `TestPlaceholderSelfContained` early-returns when the embedded file has `/assets/` → passes trivially.
- `TestServesEmbeddedSPA` also passes (materialized shell has `#root`).
- CI `go` job runs `go test ./...` on a fresh checkout (no `make build`) → embeds whatever is *committed*; if committed = materialized, tests green-light a broken page (shell references `/assets/…` not in git → cold-clone 404s). Low-likelihood but real correctness gap.

**(c) Disposition: adequate-as-is, harden via B1.** Mechanical counter-option = **defer**.

**(d) Counter-option ("materialize → go build → restore-from-template", defer).** Keep pristine banner at `pkg/web/dist.placeholder.html`, restore after `go build`.
- **Pro:** `make build` never leaves a dirty tracked file.
- **Con — duplication rot:** banner text in two committed files.
- **Con — partial-build trap:** if `go build` fails, restore never runs; needs `&&`/`trap`.
- **Already-rejected alt (confirmed still rejected):** materialize into a temp embed dir behind a build flag — silent-fallback footgun.

**Guard-robustness (CI):** correct and robust for the `make web` path. **Does not cover the `make build` commit path** — that is the gap B1 closes.

### B1 — `TestPlaceholderSelfContained` early-returns (test robustness) — FIX-NOW
**(a) What it is.** The test reads the embedded FS, not disk, and early-returns when the embed contains `/assets/`. So a locally-materialized embed skips the only self-containment check.

**(b) Real severity — escalated above "advisory".** Together with A's gap, a materialized `index.html` can be committed and CI passes. Cheap, high-leverage fix.

**(c) Disposition: fix-now.**

**(d) Fix — read the tracked source from disk, not the embedded FS; remove the early-return.** Enforces the invariant on the **committed** file regardless of local embed state. **One change closes both B1 and A's commit gap.** (Go test CWD is `pkg/web/`, so `os.ReadFile("dist/index.html")` hits the tracked file.)

### B2 — `user-scalable=no` / `maximum-scale=1.00` (WCAG 1.4.4) — DOCUMENTED (intentional)
**(a) What it is.** `web/index.html:5-8` (Vite entry → real SPA shell) disables pinch-to-zoom. The committed placeholder does **not** have the lock — ships only in real builds. SOURCE concern; surfaced by `93dfcd1`, not introduced by it.

**(b) Real severity.** WCAG 1.4.4 Resize text (Level AA) failure. For a mobile-first PWA showing code/diffs/terminal on a phone, blocking zoom is hostile to low-vision users. iOS Safari ignores `user-scalable=no` since iOS 10; **Android Chrome honors it**.

**(c) Disposition: INTENTIONAL product decision (operator-confirmed).** Zoom is disabled for app-like PWA gesture feel. Documented as an HTML comment at `web/index.html:5-8` (WCAG tradeoff consciously accepted; do not change without product review). NOT treated as a defect.

### B3 — Cosmetic `working-directory` / inline `cd web` — DROP
**(a) What it is.** `release.yml` uses inline `cd web` instead of `working-directory`; `ci.yml` e2e job repeats `working-directory: web` on three steps. **(b) Real severity: trivial/cosmetic.** **(c) Disposition: drop** (tidy only if the file is touched for another reason).

### B4 — Stale-asset accumulation in `pkg/web/dist/assets/` — DEFER → done with B5
**(a) What it is.** `web-materialize` copies into `pkg/web/dist/` without cleaning it; Vite's `emptyOutDir:true` cleans only staging. Across repeated local builds, `pkg/web/dist/assets/` accumulates orphaned hashed files.

**(b) Real severity — downgraded to low.** Releases run on fresh checkouts (never accumulate). **SW design makes accumulation *safe*:** `web/public/sw.js` is network-first for navigation and deletes old caches on activate; orphaned old assets remain embedded and servable. Only cost is local binary bloat + dev confusion.

**(c) Disposition: defer** (hygiene; not correctness). **Folded a clean-first step into the B5 shared script** (`rm -rf dest/assets dest/*.js dest/*.map dest/*.webmanifest`, preserving tracked `index.html`; safe no-op on cold clone).

### B5 — Materialize recipe duplicated (×4, not ×3) — FIX-NOW
**(a) What it is.** `cp -r web/dist-build/. pkg/web/dist/` in **4** code locations:
- `Makefile` `web-materialize`
- `Makefile` `fixtures` (inline duplicate — the easy-to-miss one)
- `.github/workflows/release.yml`
- `web/scripts/fixture-web.sh`

**(b) Real severity: low but rot-prone; the task undercounted the surface.**

**(c) Disposition: fix-now** (cheap; prerequisite for B4).

**(d) Fix — extract `web/scripts/materialize.sh`** (with B4 clean-first inside); route all 4 sites through it; change `Makefile` `fixtures:` to depend on `web-materialize`.

## 3. Prioritized recommendation (single ranked order)
1. **B2** — confirm intent, then document the conscious WCAG tradeoff (DONE — operator confirmed intentional; comment added). [Originally: drop zoom caps if accidental.]
2. **B1** — `os.ReadFile` the tracked file; removes early-return (closes B1 **and** A's commit gap).
3. **B5** — extract `materialize.sh`, dedupe incl. Makefile `fixtures` inline copy (no behavior change).
4. **B4** — add clean-first inside the B5 script (hygiene; releases already clean).
5. **A** — adopt mechanical "restore-from-template" **only if** dirty-index friction is reported after B1; otherwise the current two-layer mitigation + B1 is sufficient.
6. **B3** — drop / tidy opportunistically.

## 4. Open questions (resolved)
1. **B2 — is disabling zoom intentional?** → **YES (operator-confirmed).** Documented as a comment; not changed.
2. **B1 — confirm Go test CWD** is `pkg/web/` so `os.ReadFile("dist/index.html")` hits the tracked file → yes, by convention.

## Contradictions found
- **Task undercount vs. code:** the materialize recipe is in **4** places, not 3 (Makefile `web-materialize` + Makefile `fixtures` inline + release.yml + fixture-web.sh). Material to B5's rot argument.
- **B2 framing vs. code:** the *built* `pkg/web/dist/index.html` carries the zoom-lock at build time, but the **committed placeholder does not** — the lock lives in source `web/index.html` and appears only after materialize. Not introduced by `93dfcd1`.

## Confidence
- A, B1, B3, B4, B5: **high** (file:line + SW semantics).
- B2: **high** on the WCAG fact, **confirmed** on intent (operator).

## Follow-up status
B1, B5, B4, and the B2 comment are implemented in a parallel build slice (task `P1-WEB-026`). A and B3 remain deferred/dropped.
