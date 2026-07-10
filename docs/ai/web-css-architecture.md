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
    ├── main.css              # single entrypoint; @imports foundation then the legacy shards in order
    ├── foundation/
    │   ├── tokens.css        # :root vars + theme-* class vars + --z-* ladder
    │   ├── reset.css         # CSS reset
    │   ├── typography.css    # global typography
    │   ├── scrollbars.css   # global thin themed scrollbars (all themes, GPU-safe)
    │   ├── z-index.css       # documentation-only z-index reference
    │   └── perf-guards.css   # documentation-only performance guardrails
    └── legacy/               # former legacy.css, split into 10 ordered source-preserving shards
        ├── 00-app-globals.css              # .app + user-select globals
        ├── 10-sidebar-statusmark.css       # sidebar chrome + status-mark glyph + keyframes
        ├── 20-session-tree.css             # tree, dots, session-search, icon-btn, vh-select
        ├── 30-main-terminal.css            # .main, term-dock, main-head, main-body
        ├── 40-chat-stream.css              # HOT PATH: .chat, .chat-scroll, .msg, .md, .reasoning-body
        ├── 50-chat-overlays.css            # jump, chat-live, msg-error, perm-*, usage, status-pop, admin-menu
        ├── 60-notifications-inspector.css  # notifications, session inspector, project switcher
        ├── 65-sessions-notes-servers.css   # sidebar-foot, archived, ctxm, confirm, notes/todos, servers
        ├── 70-composer-diff-git.css        # composer/tasks, diff, git, staging, dialogs, model-rows, settings
        └── 80-professional-pass.css        # LATE professional design pass + appended features (imported LAST)
└── components/
    └── Component.tsx         # component-owned
    └── Component.module.css  # co-located scoped styles
```

Layer responsibilities:

| Layer | What lives here | Ownership |
|-------|-----------------|-----------|
| `foundation/` | Global tokens, theme, z-index, reset, typography, perf-guards | App-wide foundation — changed rarely, deliberately |
| `Component.module.css` | Component-owned scoped styles, co-located beside the `*.tsx` | Owned by that component |
| `legacy/` (10 shards) | Transitional remainder — rules not yet carved out into modules | Shrinking; each carve removes a region from a shard |

`main.css` imports the foundation files then the 10 `legacy/` shards **in
original source order**. The Stage 1 shard split was cascade-safe: concatenating
the shards in import order reproduced the former `legacy.css` **byte-for-byte**
(used as the mechanical control), so it moved bytes and added scoping where safe
without changing cascade behavior. `legacy.css` as a single file no longer exists
— it is the logical name for the ordered `legacy/` shard set. 24 components now
own their own modules (17 original + 7 Stage 2 Batch 1).

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
Follow them when carving a region out of the legacy shards into a module.

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
   (`dialog-in`, `empty-float`, `spin`, `pulse`, …) stay in the legacy shards
   (typically `10-sidebar-statusmark.css` for chrome animations).

4. **Re-read the relevant shard from disk before each carve.** Line numbers
   shift as regions are removed and shards are carved down. Never carve from a
   stale copy.

5. **Side-effect import for shared markup.** If a component's class markup is
   reused by another component (e.g. `EmptyState`'s `.empty*` reused by
   `NoProjectState.tsx`), use a side-effect import `import "./X.module.css"` plus
   `:global(...)` so the CSS bundles app-wide.

6. **Root class e2e-queried → `:global`; keep modifiers/descendants scoped.**
   e.g. Tooltip: `.tooltip` is `:global` (e2e-queried) but `.above` /
   `.tooltip-text` stay scoped. UpdateToast: `.update-toast` is `:global` but
   `-text` / `-btn` stay scoped.

7. **A 100%-`:global` module can still be worth migrating** — for
   **concurrent-edit conflict isolation** and **locate-ability**, not just CSS
   scoping. This rule was **reframed** from its original "zero scoping benefit →
   leave it in `legacy.css`": a component whose classes are all `:global` (e.g.
   `ProjectSwitcher`: all `proj-*` e2e-queried) still benefits from owning its
   own module file, because multiple agents editing CSS concurrently no longer
   fight over a shared shard and a reader can locate the component's rules
   without grepping the whole legacy set. Do NOT force migrations that need
   contortions — but do not reject a clean move solely on "it's all `:global`".

8. **Shared keyframe references from modules use the bare global animation name.**
   This project's Vite/postcss-modules resolves bare names to global keyframes
   **without** `:global()` wrapping. e.g. `animation: pulse 2s infinite;`
   resolves correctly; do not write `animation: :global(pulse) ...`.

## 4. How to migrate one component safely

A short, repeatable procedure:

1. **Determine sole-ownership.** Grep all of `web/src` for the component's
   classes. A class used only by this component is a carve candidate.
2. **Competition check (Stage 2 criterion).** A selector is migratable only if
   **ALL** of its rules can move into the module together. Grep the late
   override shard (`80-professional-pass.css`) for any rule on the same
   selectors — a competing override you cannot account for means the move would
   silently change precedence. If an unaccounted competitor exists, defer; do not
   move a partial rule set.
3. **Find test selectors.** Grep `web/tests/e2e/*.spec.ts` **and**
   `web/tests/unit/*.test.tsx` for global-selector queries on those classes.
4. **Create `Component.module.css`.** Scope sole-owned, non-test-queried classes.
   Mark shared and test-queried classes as `:global(...)`.
5. **Update the TSX.** Add `import styles from "./Component.module.css"` and
   switch scoped class refs to `styles["name"]`. Leave global classes as literal
   strings (SolidJS `class=`/`classList=` — **not** React `className`).
6. **Carve the rules out of the legacy shard.** Re-read the relevant shard from
   disk first (rule 4); line numbers have shifted.
7. **Verify** (see next section).

## 5. Verification commands (per slice)

```bash
cd web && npm run typecheck
cd web && npm run test:unit
cd web && npx vite build
cd web && export PATH=$PATH:/usr/local/go/bin && npx playwright test <relevant.spec.ts>
```

> **Vitest command note:** the canonical unit-test command is
> `cd web && npm run test:unit` (= `vitest run` via the project's local config).
> Prefer it over bare `npx vitest run`: running `npx vitest` from the repo root
> (or with a stale/cached resolver) can pick up a vitest that does not see the
> project's jsdom config, so tests fail with a missing-`jsdom`/environment error.

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

The following stay **global** in the legacy shards (mostly the `40-chat-stream.css`
hot path). They were deliberately deferred because scoping provides no benefit or
because they are high-risk GPU surfaces that warrant a dedicated session.

| Class / group | Why it stays global in the legacy shards |
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
- **Fold the "Professional design pass" `:root` token cluster** into
  `tokens.css`. These live in the late `80-professional-pass.css` shard and come
  **late in source order** to override the original tokens, so the move is
  cascade-sensitive, not mechanical — the relocation must preserve the override
  precedence (this is the same "unaccounted competitor" surface that the Stage 2
  competition check in §4 guards against).
- **Continue carving the legacy shards** for remaining shared-chrome-entangled
  components (command palette, model dialog, session inspector/tree, git view,
  etc.) when their shared-primitive seams become clear.
