# Managed project processes & views

A project can declare **companion processes** — a dashboard, a board, a docs
server, a custom view backend — in a checked-in config, and vh-solara will
discover it, **start the processes itself**, wait for them to be ready, and
**register their views** automatically whenever the project is open. No manual
launch, no SSH, no self-register code.

This complements the existing manual [`POST /vh/views`](coordination-api.md)
self-register: the manual API is for processes you launch by hand; this feature
is for processes the repo declares and vh-solara owns.

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
      // other probes: "http": "http://unix:.…/healthz" | "log": "ready serving on"
    }
  ],
  // Views vh-solara reverse-proxies (same upstream spec as POST /vh/views).
  "views": [
    {
      "id": "board",
      "title": "Board",                    // optional, default = id
      "path_prefix": "/board",             // verbatim; no trailing slash
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
  `always` restarts any exit; `no` never restarts. Backoff is exponential.
  `always` is honored **within one daemon lifetime** — it is not "survive a
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
- **Prefix isolation.** View prefixes are **verbatim** (the path you declare is
  the path served), shared in one registry with manually-registered views. On a
  single worker hosting several projects, a prefix collision is **non-fatal**:
  the process still runs, the conflicting view is marked `prefix-conflict`, and
  the first-registered view keeps the prefix.

## Readiness / health

`readiness` is optional. Omit it and vh-solara applies a default heuristic
(unix-socket upstream → ready once it accepts connections; otherwise a short
settle). Declare one of:

| Field | Ready when… |
|-------|-------------|
| `unix` | the unix socket accepts a connection |
| `http` | the URL returns a 2xx (3 s timeout) |
| `log`  | the regex matches the merged stdout/stderr |

Once ready, a process is health-checked on the same probe (if declared); sustained
failure marks it `unhealthy` and applies the restart policy. Startup that never
becomes ready within ~30 s is marked `failed`.

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
with `status` ∈ `stopped \| starting \| ready \| unhealthy \| failed`.
