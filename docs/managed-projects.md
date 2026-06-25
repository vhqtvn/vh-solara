# Managed project processes & views

A project can declare **companion processes** — a dashboard, a board, a docs
server, a custom view backend — in a checked-in config, and vh-solara will
discover it, **start the processes itself**, wait for them to be ready, and
**register their views** automatically whenever the project is open. No manual
launch, no SSH, no self-register code.

This complements the existing manual [`POST /vh/views`](coordination-api.md)
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

### UI settings (`notes`)

A top-level `"notes": true | false` enables/disables the **Notes** tab for this
project, overriding the user's global Notes setting (Settings → General; off by
default). It is a display flag only — **not** part of the trust hash, so toggling
it never re-gates the declared processes, and it is read without a trust prompt.

```jsonc
{ "notes": true, "processes": [ /* … */ ] }
```

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
