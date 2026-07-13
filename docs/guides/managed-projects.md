# Managed project processes & views

A project can declare **companion processes** — a dashboard, a board, a docs
server, a custom view backend — in a checked-in config, and vh-solara will
discover it, **start the processes itself**, wait for them to be ready, and
**register their views** automatically whenever the project is open. No manual
launch, no SSH, no self-register code.

This complements the existing manual [`POST /vh/views`](../architecture/coordination-api.md)
self-register: the manual API is for processes you launch by hand; this feature
is for processes the repo declares and vh-solara owns.

> Building the embedded web app itself (the iframe/proxy contract, theme tokens,
> and what JS/interactivity is allowed within the sandbox) is documented
> separately in **[custom-views.md](custom-views.md)** — hand that to the repo
> implementing the view.

> **Worker prerequisite:** like the rest of `/vh/*`, managed processes run on the
> `client-daemon` web server (`--web vh` mode).

## The config

Commit `.vh-solara/project.jsonc` (JSON with comments) at the project root:

```jsonc
{
  // Processes vh-solara starts + supervises for the project.
  "processes": [
    {
      "id": "board",                       // stable id, unique in this file
      "command": "board serve --socket .vh-solara/run/board.sock",
      // "command": ["board", "serve", "--socket", "…"]   // array form = direct argv
      "cwd": ".",                          // optional, default = project root
      "env": { "BOARD_FOO": "bar" },       // optional, merged over the daemon env
      "restart": "on-failure",             // on-failure (default) | always | no
      "readiness": { "unix": ".vh-solara/run/board.sock" }
      // other probes: "http": "http://127.0.0.1:8080/healthz" | "log": "ready serving on"
    }
  ],
  // Views vh-solara reverse-proxies (same upstream spec as POST /vh/views).
  "views": [
    {
      "id": "board",
      "title": "Board",                    // optional, default = id
      "path_prefix": "/board",             // mounted per-project at /_p/<hash>/board
      "upstream": "unix:.vh-solara/run/board.sock",
      "depends_on": "board"                // process id backing the socket
    }
  ]
}
```

**Paths** are relative to the project root. A `command` string runs under
`/bin/sh -c`; an array is a direct argv. `upstream` accepts the same forms as the
manual view API: `unix:<path>`, `http(s)://host[:port]`, `tcp:host:port`.

A config is optional — no file means nothing is managed for the project.

> **What to commit:** `project.jsonc` is the declarative surface — processes,
> views, and the `notes` flag. The display-only `agentStyles` you set via the
> editor are saved to a **separate, gitignored** `.vh-solara/preferences.local.jsonc`
> instead, so personalizing your UI never dirties `git status`. On project open,
> any `agentStyles` left in `project.jsonc` is **auto-migrated** to that local
> overlay (one-time, idempotent), and a `.vh-solara/.gitignore` is auto-created to
> keep the overlay out of `git status`. See
> [Agent styles](#agent-styles-agentstyles).

### UI settings (`notes`)

A top-level `"notes": true | false` enables/disables the **Notes** tab for this
project, overriding the user's global Notes setting (Settings → General; off by
default). It is a display flag only — **not** part of the trust hash, so toggling
it never re-gates the declared processes, and it is read without a trust prompt.

```jsonc
{ "notes": true, "processes": [ /* … */ ] }
```

### Session names (`nameReplacements`)

Show session titles the way *you* want to read them, without changing the real
title. Each rule is a regex text replacement applied to the raw title at
**display leaves only** — the session tree, tooltips, command palette,
inspector header, and notification list. Everything that must stay canonical
keeps the **raw** title: search filters, copy buffers, the rename input, export
headings/filenames, archive targets, and terminal binding.

```jsonc
{
  "nameReplacements": [
    { "pattern": "\\[\\[IMPORTANT\\]\\]", "replacement": "❗", "flags": "g" },
    { "pattern": "^WIP:\\s*", "replacement": "" }
  ]
}
```

- **`pattern`** — a JS regex *source* string. Escape metacharacters you want to
  match literally (e.g. `\\[\\[` for `[[`).
- **`replacement`** — a JS replacement string; `$&`, `$1`, and named captures
  are supported. An intentionally empty result is valid (it just trims).
- **`flags`** — JS regex flags, e.g. `g` to replace every match; omit it for a
  single (first) replacement.

Rules apply **sequentially** — rule *n* sees rule *n*−1's output — so you can
chain a normalization step before a substitution. Each rule compiles
**fail-soft**: an invalid pattern or flags is skipped (and flagged per-row in
the editor) so a later valid rule still applies; a bad rule never breaks
rendering. Like `agentStyles`, this is display-only — **not** part of the trust
hash — and it is edited on the **Preferences** screen (project menu →
Preferences), which writes it to the gitignored
`.vh-solara/preferences.local.jsonc` overlay alongside your `agentStyles`.

### Agent styles (`agentStyles`)

Give specific agents a distinct look so, say, a supervisor stands apart from the
everyday build/coordination agents. Map an agent name to a display treatment:

```jsonc
{
  "agentStyles": {
    "supervisor":   { "label": "SUP",   "color": "danger",  "style": "solid"   },
    "coordination": { "label": "COORD", "color": "accent2", "style": "outline" },
    "build":        { "color": "accent" }
  }
}
```

- **`label`** — a terse chip text (≤ 6 chars). Only agents with a label get a
  chip on their messages; everything else keeps the plain `@name`, so the
  message head stays compact. Opt agents in deliberately.
- **`color`** — a **theme token name**, never a raw color: one of `accent`,
  `accent2`, `ok`, `warn`, `danger`, `muted` (the OpenCode spellings
  `success`/`warning`/`error` are accepted as aliases). Any other value is
  ignored. The chip and the composer's agent picker pick up the theme color, so
  it stays correct across light/dark and custom themes.
- **`style`** — the chip variant: `soft` (faint tint, default), `outline`
  (bordered), or `solid` (filled).

Like `notes`, this is display-only — **not** part of the trust hash, and it's
sanitized client-side (no arbitrary color or CSS reaches the page).

#### Where it's saved — `project.jsonc` vs `preferences.local.jsonc`

`agentStyles` is a **personal UI preference**, not a repo declaration. The
in-product editor (project menu → **Preferences**) writes it to a **gitignored local
overlay** at `.vh-solara/preferences.local.jsonc`, so styling your agents never
dirties `git status` and never conflicts on a `git pull`. The editor and the
agent chips read a merge of two files:

- **`.vh-solara/preferences.local.jsonc`** (local, **gitignored**) — where the
  editor saves. If it declares `agentStyles`, that map **fully replaces** the
  base (a whole-map overwrite, not a per-agent merge). Absent, or present without
  the key → the base is used as-is. Your `nameReplacements` rules live here too
  (see [Session names](#session-names-namereplacements)).
- **`.vh-solara/project.jsonc`** (committed) — **declarative-only** (processes,
  views, `notes`). It no longer holds `agentStyles` in steady state: on project
  open, any `agentStyles` found here is **auto-migrated** into the local overlay
  (comment-preserving removal from `project.jsonc`, value written to
  `preferences.local.jsonc`), so a repo may still ship a starter map that each
  operator's first open adopts as their personal default — but it then lives in
  their ignored overlay, never written back into `project.jsonc`.

The first open of a project also auto-creates a `.vh-solara/.gitignore` (with
`*.local` / `*.local.jsonc`) if one is not already present, so the local overlay
stays out of `git status` without each operator having to add it by hand. Both
the migration and the `.gitignore` step are idempotent — re-running them is a
no-op once the steady state is reached.

`notes` stays a `project.jsonc` declaration: it has no UI writer, so set it by
hand (see above). In practice, then, `project.jsonc` is **declarative-only**
(processes, views, `notes`), while each operator's personal `agentStyles` and
`nameReplacements` live in the ignored overlay.

## Trust

Because the config can declare arbitrary shell commands, **vh-solara will not run
it until you approve it.** On first open (and whenever the config changes) the
project enters an `awaiting-trust` state and the UI shows a review card with the
exact command, working directory, environment keys, restart policy, and socket
of each process — *before* anything executes. Click **Trust & run** (or
**Re-approve & run** after a change) to grant.

The grant is stored per project directory and per config hash, so an unchanged
config is not re-prompted across daemon restarts. See
[SECURITY.md](../SECURITY.md#repo-declared-managed-processes-workspace-trust)
for the full trust model.

For single-operator / headless setups, pass `--trust-on-open` (or set
`VH_TRUST_CONFIG=1`) to auto-grant on discovery.

## Lifecycle

- **Start.** Processes start when the project is opened *and* trusted. vh-solara
  waits for `readiness` (default heuristic if omitted: a unix-socket upstream is
  ready once it accepts connections, otherwise a short startup settle), then
  registers the dependent views. Process health, logs, and start/stop/restart
  controls surface in the UI's project-processes panel.
- **Restart policy.** `on-failure` (default) restarts a non-zero exit;
  `always` restarts any exit; `no` never restarts. Backoff is exponential, and
  the failure streak resets only after a process stays ready a while — so a
  crash-after-ready keeps backing off instead of hammering. `on-failure` gives up
  (→ `failed`) after a run of consecutive failures; `always` retries forever (but
  still backs off). `always` is honored **within one daemon lifetime** — it is not "survive a
  daemon restart" (see next point).
- **Daemon restart.** Processes do **not** auto-start on boot. They come back
  lazily when a browser re-opens the project (the persisted trust record means
  no re-prompt unless the config changed). This is deliberate: a daemon restart
  should never silently start running repo-declared commands without an operator
  present.
- **Teardown.** Processes run until you stop them or the daemon exits. There is
  no auto-teardown on project close — closing a tab does not kill your board.
  On daemon exit all managed processes are gracefully stopped (SIGTERM → SIGKILL)
  in defined order.
- **Per-project isolation.** Managed views are mounted under a **per-project
  namespace** — the path you declare (`/board`) is served at
  `/_p/<project-hash>/board`, and the iframe loads that path. This makes every
  project's views fully independent: two projects on one worker can each declare
  `/board` (and the same view `id`) without colliding, and a project's switcher
  shows only its own views (plus any global manual `POST /vh/views` ones). The
  only collision left is **intra-project** — two views in one config declaring
  the same prefix — and it is **non-fatal**: the process still runs, the losing
  view is marked `prefix-conflict`, and the first-registered one keeps the path.

## Readiness / health

`readiness` is optional. Omit it and vh-solara applies a default heuristic: if a
dependent view (`depends_on`) binds a `unix:` socket, the process is ready once
that socket accepts connections; otherwise a short settle. Or declare one of:

| Field | Ready when… | Recurring health check? |
|-------|-------------|-------------------------|
| `unix` | the unix socket accepts a connection | yes |
| `http` | the URL (a `http(s)://host:port/…`, **not** a unix socket) returns a 2xx (3 s timeout) | yes |
| `log`  | the regex matches the merged stdout/stderr | no — startup-only (the line scrolls out of the log ring) |

Once ready, a process is health-checked on the same probe **except `log`**, which
is a one-shot startup signal; sustained failure marks it `unhealthy` and applies
the restart policy. Startup that never becomes ready within ~30 s is marked
`failed`.

A view with `depends_on` is **not registered until its process is ready** — so it
never proxies to a not-yet-bound socket; until then it shows `pending`.

## HTTP API

All behind the worker's auth + CSRF guard (`X-VH-CSRF: 1` on mutations).

| Method | Route | Purpose |
|--------|-------|---------|
| `GET`  | `/vh/managed?dir=` | Project status: `state` (`none` \| `awaiting-trust` \| `changed` \| `trusted`), `review` (the declared config, present until trusted), `processes[]`, `views[]` |
| `POST` | `/vh/managed?dir=&id=&action=start\|stop\|restart` | Control a process |
| `GET`  | `/vh/managed?dir=&id=&logs[&max=N]` | Tail of the process log ring (text/plain) |
| `GET`  | `/vh/trust?dir=` | Trust state + config hash |
| `POST` | `/vh/trust`  body `{"dir":"…"}` | Grant trust → starts the processes |

A `processes[]` entry: `{id,status,pid,command,restart,started_at,ready_at,exit_code,restarts}`
with `status` ∈ `stopped \| starting \| ready \| unhealthy \| failed`. A `views[]`
entry: `{id,path_prefix,status}` with `status` ∈ `registered \| prefix-conflict \|
pending` (`pending` = declared but not registered because the project isn't
trusted yet).

`state` is computed from the config **on disk right now** vs. the trust record,
so editing the config while the daemon is up flips the project to `changed`
immediately. Editing does **not** disturb already-running processes — they keep
the last-approved config, and even a manual `start`/`restart` relaunches the
*approved* config, never an unreviewed edit. The new commands run only after you
re-approve.
