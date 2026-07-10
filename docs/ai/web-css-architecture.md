# Web CSS architecture (AI-first)

This is the durable reference for the vh-solara web frontend's CSS architecture.
It documents the target structure, token model, the migration carry-forward
rules, the per-component migration procedure, verification, the z-index ladder,
Firefox/WebRender guardrails, the deliberately-legacy hot paths, and open
follow-ups.

Read this **before adding or moving component CSS**. It exists so future agents
(human and AI) maintain the architecture instead of rediscovering it.

## 1. Target structure

The monolithic `web/src/styles.css` (4,599 lines) was refactored into a hybrid
AI-first architecture. The single entrypoint is imported once from `index.tsx`.

```
web/src/
├── index.tsx                 # imports "./styles/main.css" once
└── styles/
    ├── main.css              # single entrypoint; @imports foundation then legacy.css
    ├── foundation/
    │   ├── tokens.css        # :root vars + theme-* class vars + --z-* ladder
    │   ├── reset.css         # CSS reset
    │   ├── typography.css    # global typography
    │   ├── z-index.css       # documentation-only z-index reference
    │   └── perf-guards.css   # documentation-only performance guardrails
    └── legacy.css            # transitional remainder (~3,565 lines, shrinking)
└── components/
    └── Component.tsx         # component-owned
    └── Component.module.css  # co-located scoped styles
```

Layer responsibilities:

| Layer | What lives here | Ownership |
|-------|-----------------|-----------|
| `foundation/` | Global tokens, theme, z-index, reset, typography, perf-guards | App-wide foundation — changed rarely, deliberately |
| `Component.module.css` | Component-owned scoped styles, co-located beside the `*.tsx` | Owned by that component |
| `legacy.css` | Transitional remainder — rules not yet carved out into modules | Shrinking; each carve removes a region |

`main.css` imports the foundation files then `legacy.css` **in original source
order**, so the refactor changed zero cascade behavior — it only moved bytes and
added scoping where safe.

> Note: `@layer` is currently shipped as a **comment**, not active. See
> "Open follow-ups" for why promoting it is cascade-sensitive.

## 2. Token rules

**JavaScript is the authority for theme tokens.** CSS modules and foundation
files *consume* tokens; they do not redefine the theme model.

- `theme.ts` toggles `theme-*` / `theme-light-scoped` classes on `<html>` and
  writes custom-theme CSS vars inline. This is the runtime theme switch.
- `themeTokens.ts` publishes the `--vh-*` embedded-view token contract.
- `font.ts` drives `--font-ui`.

Rules:

1. **Modules CONSUME global vars** (`var(--bg-2)`, `var(--text-1)`, etc.). They
   must **NOT** define new global theme tokens — those belong in
   `foundation/tokens.css`.
2. **New semantic tokens** belong in `foundation/tokens.css` and must bridge
   through the existing JS model when they are externally visible (i.e. when
   they participate in theme switching or are consumed by embedded views).
3. **`--vh-*` tokens are the stable embedded-view contract.** Treat them as a
   public surface — change them deliberately, not in passing.

## 3. The 8 migration carry-forward rules

These are the hard-won AI-first guidance distilled from the actual migration.
Follow them when carving a region out of `legacy.css` into a module.

1. **Test-queried classes stay `:global`.** For each class, grep **both**
   `web/tests/e2e/*.spec.ts` **and** `web/tests/unit/*.test.tsx`. If **any** test
   queries the class by global selector (`page.locator`, `document.querySelector`,
   `.foo`), keep it `:global(...)`.
   *(The surprise that produced this rule: `QuestionCard.test.tsx` queries
   `.question-options` / `.question-opt` / `.question-send`.)*

2. **Shared/global primitives stay `:global`.** Classes referenced by more than
   one component must remain global. Known shared primitives:
   `.icon-btn`, `.dot`, `.dialog` base, `.on`, `.warn`, `.ok`, `.active`, `.btn`,
   `.btn-primary`, `.link-btn`, `.seg`, `.rot`, `.hot`, `.bad`, `.open`, `.err`.

3. **Shared keyframes stay global.** Migrate a `@keyframes` local **only if** it
   is sole-owned **and** all referrers move with it. Shared keyframes
   (`dialog-in`, `empty-float`, `spin`, `pulse`, …) stay in `legacy.css`.

4. **Re-read `legacy.css` from disk before each carve.** Line numbers shift as
   regions are removed. Never carve from a stale copy.

5. **Side-effect import for shared markup.** If a component's class markup is
   reused by another component (e.g. `EmptyState`'s `.empty*` reused by
   `NoProjectState.tsx`), use a side-effect import `import "./X.module.css"` plus
   `:global(...)` so the CSS bundles app-wide.

6. **Root class e2e-queried → `:global`; keep modifiers/descendants scoped.**
   e.g. Tooltip: `.tooltip` is `:global` (e2e-queried) but `.above` /
   `.tooltip-text` stay scoped. UpdateToast: `.update-toast` is `:global` but
   `-text` / `-btn` stay scoped.

7. **Deferred-after-recon is a GOOD outcome.** Do NOT force a migration that
   needs contortions. A component that is 100% `:global` (e.g. `ProjectSwitcher`:
   all `proj-*` e2e-queried) gives **zero scoping benefit** — leave it in
   `legacy.css`.

8. **Shared keyframe references from modules use the bare global animation name.**
   This project's Vite/postcss-modules resolves bare names to global keyframes
   **without** `:global()` wrapping. e.g. `animation: pulse 2s infinite;`
   resolves correctly; do not write `animation: :global(pulse) ...`.

## 4. How to migrate one component safely

A short, repeatable procedure:

1. **Determine sole-ownership.** Grep all of `web/src` for the component's
   classes. A class used only by this component is a carve candidate.
2. **Find test selectors.** Grep `web/tests/e2e/*.spec.ts` **and**
   `web/tests/unit/*.test.tsx` for global-selector queries on those classes.
3. **Create `Component.module.css`.** Scope sole-owned, non-test-queried classes.
   Mark shared and test-queried classes as `:global(...)`.
4. **Update the TSX.** Add `import styles from "./Component.module.css"` and
   switch scoped class refs to `styles["name"]`. Leave global classes as literal
   strings (SolidJS `class=`/`classList=` — **not** React `className`).
5. **Carve the rules out of `legacy.css`.** Re-read `legacy.css` from disk first
   (rule 4); line numbers have shifted.
6. **Verify** (see next section).

## 5. Verification commands (per slice)

```bash
cd web && npm run typecheck
cd web && npx vitest run
cd web && npx vite build
cd web && export PATH=$PATH:/usr/local/go/bin && npx playwright test <relevant.spec.ts>
```

Typecheck + vitest + vite build + targeted e2e is the **sufficient net** for a
CSS-module migration. The reasoning: such a change only moves bytes verbatim and
adds scoping; untouched rules stay byte-identical, so the build + targeted tests
catch regressions without a full e2e sweep.

> SolidJS note: components use `class=` / `classList=` (NOT React `className`).
> `vite/client` (in tsconfig `types`) already declares `*.module.css`, so **no
> typing shim is needed**. CSS Modules are Vite-native — no Sass/Tailwind/PostCSS
> framework dependencies.

## 6. z-index ladder

The `--z-*` token ladder lives in `foundation/tokens.css` (see also
`foundation/z-index.css` for the documentation-only reference).

- **Replace raw z-index literals** with `var(--z-*)` tokens **where a matching
  token exists**.
- **Document genuine ladder gaps** with an inline comment rather than inventing
  an off-ladder magic number.
- **Local intra-component stacking contexts** (z-index 1–30 within a single
  component's own stacking context) may stay literal.

## 7. Firefox/WebRender performance — reference, don't duplicate

The full forbidden-pattern list and the heat-saga diagnosis notes live in
**AGENTS.md → "Web frontend performance — Firefox/WebRender GPU gotchas"**.
`foundation/perf-guards.css` documents the same guardrails locally. This doc does
not duplicate that list.

**Binding rule for CSS module work:** when adding or moving styles into a module,
do not introduce:

- `mask-image` / `-webkit-mask` on a scroll container, and
- `backdrop-filter: blur` on overlays, and
- per-element `contain: paint` / `content-visibility: auto`.

These are the patterns that historically pinned a GPU to ~99°C on
Firefox/WebRender. (Per-element `contain`/`content-visibility` made it *worse*
there, not better — each becomes a compositing surface.)

**Migration acceptance checklist:**

1. Run the forbidden-pattern grep on the new module (see AGENTS.md list).
2. If the component is a scroll/streaming hot path (chat scroll, message list,
   reasoning body), apply extra review — the cost of a mistake is a stuck-hot
   GPU, not a visual bug.

## 8. Hot paths (deliberate-legacy) — what was NOT migrated and why

The following stay **global** in `legacy.css`. They were deliberately deferred
because scoping provides no benefit or because they are high-risk GPU surfaces
that warrant a dedicated session.

| Class / group | Why it stays global in `legacy.css` |
|---------------|--------------------------------------|
| `.md` + `.md *` | innerHTML-generated markdown typography — styles raw elements (`h1`/`p`/`a`/`code`); scoping has no benefit |
| `.md-raw` | shared with `GitView.tsx` |
| `.stream-caret` + `@keyframes stream-blink` | DOM-created via imperative `createElement` inside `.md` content |
| `.filepath` / `.code-block` / `.code-actions` / `.code-wrap` / `.code-copy` / `.code-pathlike` / `pre.wrap` | DOM-injected into innerHTML |
| `.chat-scroll` / `.reasoning-body` / `.msg-*` | ChatView.tsx GPU-hottest surface (the `mask-image` heat-saga origin) — deferred to a dedicated follow-up session |

## 9. Open follow-ups

These are tracked intentionally; the structure is in place but the work is
deferred because each is cascade-sensitive, not mechanical.

- **Promote `@layer` from comment to active.** The `@layer` declaration currently
  ships as a *comment*. Rule-by-rule deliberate assignment is needed because
  layer-order beats specificity and `!important` resolves earliest-layer-first.
  Concrete regression risk: `:root.theme-light-scoped .vh-diff-*` would lose to
  plain legacy `.vh-diff-*`. Do this carefully, later.
- **Fold the "Professional design pass" `:root` token cluster** (legacy
  ~3096–3171) into `tokens.css`. These come **late in source order** to override
  the original tokens, so the move is cascade-sensitive, not mechanical — the
  relocation must preserve the override precedence.
- **Continue carving `legacy.css`** for remaining shared-chrome-entangled
  components (command palette, model dialog, session inspector/tree, git view,
  etc.) when their shared-primitive seams become clear.
