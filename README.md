# VHSolara

**VHSolara** (binary: `vh-solara`) is a lightweight, mobile-first web UI and aggregating daemon for OpenCode — control your coding agents on any machine, from one place, over a secure tunnel.

A single Go binary runs next to OpenCode on each machine: it aggregates OpenCode's state into a resumable, real-time view and serves a custom, mobile-first web UI (a SolidJS SPA, installable as a PWA) embedded in the binary via `//go:embed`. Each instance connects to a central controller through a persistent multiplexed WebSocket tunnel ([yamux](https://github.com/hashicorp/yamux)), so you can reach and drive any machine's OpenCode sessions from one URL — with **no inbound network access to the worker**. The UI covers the full loop: a session/subsession tree, streaming chat, diffs, an in-browser terminal, git actions, a command palette, and live notifications.

> Built because OpenCode's own web UI and OpenChamber were heavy and didn't hold up on mobile (esp. Galaxy Fold) — `vh-solara` is the lean, phone-friendly alternative, resilient to flaky networks and reconnects.

## Architecture

The system has three parts:

1. **Client Daemon (`vh-solara client-daemon`)** — runs on each machine. It owns/attaches to a local `opencode serve`, subscribes to its event stream into a materialized, resumable view, serves the embedded web UI, and connects out to the controller via a multiplexed WebSocket tunnel. (The UI is selectable with `--web`: the built-in **`vh`** UI is the flagship; `opencode` and the legacy `openchamber` remain options.)
2. **Central Controller Server (`vh-solara server`)** — runs on a trusted server, tracks connected machines, and reverse-proxies browser traffic to the right worker through the tunnel.
3. **OpenCode** — the agent runtime, run locally on each machine; the daemon talks to it over its HTTP API and never exposes it directly.

The controller presents two services:
1. A dashboard and reverse proxy on `--addr` for browser traffic.
2. A WebSocket tunnel ingestion port on `--daemon-addr` for client-daemon connections.

The tunnel uses yamux multiplexing, so each HTTP request (and the terminal/SSE upgrades) gets its own independent stream — fully parallel, bidirectional, over a single WebSocket connection.

When a browser hits a subdomain like `worker-id.mysite.com`, the controller proxies the request through the tunnel to that worker's local UI.

## Installation

Download and install the latest binary automatically:

```bash
curl -sL https://raw.githubusercontent.com/vhqtvn/vh-solara/main/install.sh | bash
```

### Prerequisites

On each client machine, you need:
- **OpenCode** binary (`opencode`) — for the default `--web=opencode` mode (uses OpenCode's built-in [`opencode web`](https://opencode.ai/docs/web/) UI).
- **Bun** runtime + **@openchamber/web** installed — only required when using `--web=openchamber` (the legacy UI).

### Manual Build

The whole UI is compiled into `pkg/web/dist` and baked into the Go binary with
`//go:embed` — so a build produces **one self-contained executable** (~18 MB)
with no runtime asset files to ship.

```bash
git clone https://github.com/vhqtvn/vh-solara
cd vh-solara

make build      # builds the SPA (needs Node ≥ 20 once) then the embedded binary → ./vh-solara
# or
make install    # same, then `go install .` into $GOBIN
```

> If `pkg/web/dist` is committed (it is, for releases), a plain `go build` /
> `go install github.com/vhqtvn/vh-solara@latest` works with **no Node toolchain** —
> the prebuilt UI is already in the source tree and gets embedded directly.
> To rebuild the UI from source: `cd web && npm install && npm run build` (or `make web`).

### Docker

A multi-stage `Dockerfile` builds the SolidJS UI, compiles a static binary with
the UI embedded, and ships a ~30 MB Alpine image:

```bash
docker build -t vh-solara .
docker run --rm vh-solara version
```

`docker-compose.yml` provides two services:

```bash
# Central controller (dashboard :8080, daemon tunnel :8081).
# Override the routing domain with VH_HOST_DOMAIN (default: localhost).
VH_HOST_DOMAIN=mysite.com docker compose up -d server

# Zero-dependency demo of the vh web UI on :8099 — runs the real aggregator and
# web server against fake OpenCode fixtures, no `opencode` binary required.
docker compose --profile demo up ui-demo
```

> The runtime image contains only the binary + CA certs. The `client-daemon`
> needs an `opencode` binary (and, for namespace isolation, `ip`) available at
> runtime — provide those in a derived image or bind-mount when running the
> daemon in a container.

## Usage

### Try it locally (no controller, no tunnel)

The quickest way to see the `vh` UI: run everything on one machine and open a
browser. `local-server` spawns/attaches an OpenCode backend and serves the full UI
directly — no controller, no `client-daemon`, no tunnel.

```bash
vh-solara local-server --addr 127.0.0.1:7700   # then open http://127.0.0.1:7700
```

Loopback binds need no auth; to expose it, add `--auth-mode` (see [SECURITY.md](SECURITY.md)).
For multi-machine remote access, set up the controller + client daemon below.

### 1. Run the Controller Server

Start the central server on a trusted machine (or via Nginx reverse proxy):

```bash
./vh-solara server --addr :8080 --daemon-addr :8081 --host-pattern '$ID.mysite.com' \
    --worker-secret "$VH_WORKER_SECRET"     # workers must present a matching --controller-secret
```

Access the UI at `http://localhost:8080` to view and manage active workers.
Add authentication (`--auth-mode oidc|passphrase|trust-proxy`) per
**[SECURITY.md](SECURITY.md)** — a public bind with no auth still serves but logs a
loud warning.

### 2. Run the Client Daemon

Start the daemon on each developer machine. Three web UI backends are available via `--web`:

- `vh` — vh-solara's own built-in UI: a stateful daemon (persistent OpenCode subscription, materialized view, resumable sync) serving a lightweight SolidJS client designed for phone/multi-client use, with a real sidebar, an eager session→subsession tree, server-side markdown/highlight/diff rendering, and a git Changes view. See `web/` and `documents/03`–`04`.
- `opencode` (default) — OpenCode's built-in `opencode web` UI.
- `openchamber` — the legacy OpenChamber UI.

#### vh (built-in stateful UI)

```bash
./vh-solara client-daemon \
    --web vh \
    --controller ws://server:8081/vh-solara/ws \
    --controller-secret "$VH_CONTROLLER_SECRET" \  # must match the controller's --worker-secret
    --id my-dev-01 \
    --name "My Local Desktop" \
    --opencode-bin /usr/local/bin/opencode
```

**Multiple projects.** One daemon can serve several project directories at once.
The sidebar has a **project switcher** ("Add project…" takes an absolute path);
each project is a directory, and the daemon lazily runs a separate
aggregator + OpenCode subscription per directory (via the `x-opencode-directory`
scope). Each connected client picks its own project independently, and sessions /
archive are tracked per project. (Project notes/todos are currently global —
per-project notes are a follow-up.)

The daemon runs `opencode serve` headless on a private loopback port, aggregates its
state, and serves the vh UI on the controller-proxied port. The UI is embedded in the
binary; to rebuild it after changing `web/`:

```bash
cd web && npm install && npm run build   # emits into pkg/web/dist (Go-embedded)
```

**Reload / restart / update under a supervisor (systemd).** With the default
setup the daemon spawns and owns OpenCode, so the UI's *Reload server state* and
*Restart OpenCode* work directly. But a vh **self-update** (`vh-solara update`)
needs the daemon to restart, which — when it owns OpenCode — also restarts
OpenCode.

**Recommended: `--opencode-detached`.** vh still spawns OpenCode for you (no
separate service to manage), but **detached** and tracked via a per-project
pidfile. On a vh restart/self-update, vh checks whether *its* OpenCode is still
alive + reachable and **reconnects** to it instead of spawning a duplicate — so
the session survives. On shutdown vh leaves it running (to reconnect next time).

```bash
./vh-solara client-daemon --web vh --opencode-detached \
    --controller ws://server:8081/vh-solara/ws --id my-dev-01
# pidfile + log live under $XDG_CONFIG_HOME/vh-solara/opencode/<project>.{json,log}
```

Alternatively, run OpenCode as its **own** service and point vh at it
(external-managed mode):

```bash
# opencode.service runs e.g.:  opencode serve --port 4096 --hostname 127.0.0.1
./vh-solara client-daemon --web vh \
    --opencode-url http://127.0.0.1:4096 \
    --opencode-restart-cmd 'systemctl --user restart opencode' \
    --controller ws://server:8081/vh-solara/ws --id my-dev-01
```

**`--external-managed`** is a *separate* concern: it tells vh that **the vh
daemon itself** runs under a supervisor (e.g. systemd with `Restart=always`). It
changes how the UI's *Restart vh server* / self-update-apply behaves — vh exits
cleanly and lets the supervisor relaunch it, instead of re-exec'ing its own
binary. Combine it with `--opencode-detached` (or `--opencode-url`) so OpenCode
survives the vh restart and the relaunched daemon reconnects.

Now vh **attaches** instead of spawning; `vh-solara update` then
`systemctl --user restart vh-solara` re-attaches to the still-running OpenCode
and re-hydrates (sessions intact). The UI's *Restart OpenCode* / *Update OpenCode*
run `--opencode-restart-cmd` (so they go through systemd). Use `Restart=always`
in the vh unit so a self-update's exit is picked up.

> **Important — `KillMode=process` when vh spawns OpenCode detached under systemd.**
> A detached OpenCode is set-sid'd but still lives in vh's systemd **cgroup**.
> With the default `KillMode=control-group`, restarting the vh unit kills the
> *whole cgroup* — so OpenCode (and any MCP servers) die too and running turns
> stop, defeating `--opencode-detached`. Set `KillMode=process` on the vh unit so
> a restart only stops vh's main process and the detached OpenCode survives:
>
> ```ini
> # ~/.config/systemd/user/vh-solara.service → [Service]
> Restart=always
> KillMode=process
> ```
>
> Then `systemctl --user daemon-reload`. (Not needed with `--opencode-url`, where
> OpenCode is its own unit with its own cgroup.)

#### Default: OpenCode Web

```bash
./vh-solara client-daemon \
    --controller ws://server:8081/vh-solara/ws \
    --controller-secret "$VH_CONTROLLER_SECRET" \  # must match the controller's --worker-secret
    --id my-dev-01 \
    --name "My Local Desktop" \
    --opencode-bin /usr/local/bin/opencode \
    --opencode-password secret   # sets OPENCODE_SERVER_PASSWORD on the web UI
```

#### Legacy: OpenChamber

```bash
./vh-solara client-daemon \
    --web openchamber \
    --controller ws://server:8081/vh-solara/ws \
    --controller-secret "$VH_CONTROLLER_SECRET" \  # must match the controller's --worker-secret
    --id my-dev-01 \
    --name "My Local Desktop" \
    --bin /usr/local/bin/opencode \
    --chamber 'cd /opt/openchamber && bun run node_modules/@openchamber/web/server/index.js'
```

> **Note**: In `openchamber` mode, `--chamber` takes a bash script and `--port` is appended as an argument. Environment variables `OPENCODE_HOST`, `OPENCODE_PORT`, `OPENCODE_SKIP_START`, and `PORT` are also set. If omitted, sessions run without the OpenChamber web UI.

### 3. Start or Control OpenCode

Once the `client-daemon` is running, use `vh-solara` from the CLI to start sessions:

```bash
# Starts a new OpenCode session in the current directory
vh-solara

# List active sessions (interactive TUI)
vh-solara list

# Kill a session by UUID
vh-solara kill <uuid>
```

### 4. Access the Web UI

With wildcard DNS and Nginx routing `*.mysite.com` to the server's `--addr`:

1. Developer agent `my-dev-01` connects to the server.
2. Browse to `https://my-dev-01-<uuid>.mysite.com`.
3. The server proxies your browser session through the tunnel to the worker's local web UI (OpenCode Web by default, or OpenChamber with `--web=openchamber`).
4. Visit `http://localhost:8080` for the management dashboard.

The `vh` UI is a **PWA**: open it in a browser and use "Install app" (desktop
Chrome/Edge, or "Add to Home Screen" on mobile) to run it as a standalone app.
The app shell is cached (instant loads, offline-tolerant); when the server is
updated to a new build, an unobtrusive **"A new version is available — Reload"**
toast appears, and the new version loads when you choose to reload (never mid-task).

## Security

In-binary authentication (OIDC / shared passphrase / trust-proxy), a
worker-registration secret, server-side `HttpOnly` sessions, and browser hardening
(a CSRF custom-header guard on `/oc/*` + mutating `/vh/*`, a CSP with no external
origins, strict same-origin CORS). Workers bind loopback and are reachable only
through the controller, which is the single user-auth edge.

See **[SECURITY.md](SECURITY.md)** for the model and how to configure it, and
[`documents/06-auth.md`](documents/06-auth.md) for the design rationale.

## CLI Subcommands

| Command | Description |
|---------|-------------|
| `local-server` | Serve the `vh` UI locally — no controller/tunnel (single-host) |
| `client-daemon` | Run the persistent client daemon (connects to a controller) |
| `server` | Run the central controller server |
| `list` | List active OpenCode sessions (interactive TUI) |
| `kill` | Stop **all** local vh daemons + the OpenCode instances they own (global) |
| `health` | Print local health/debug info |
| `version` | Print version/build info |
| `update` | Download + install the latest release binary, verified by SHA256 |

`vh-solara kill` stops every vh daemon registered on this machine and any
detached OpenCode it spawned (`--opencode-detached`), regardless of directory —
since detached OpenCode is intentionally left running across vh restarts, this
is how you fully tear it down. `--force` uses SIGKILL.

### Updating

```bash
vh-solara update          # checks the latest GitHub release, verifies SHA256, replaces the binary
vh-solara update --yes    # skip the confirmation prompt
```

`update` atomically replaces the running executable; **restart the daemon to
apply** the new version (which restarts OpenCode — sessions persist in OpenCode's
store). It refuses to install a release that doesn't publish a `SHA256SUMS`
checksum file. The web UI also offers, in the server status popover, **"Reload
server state"** (rebuild the daemon's view from OpenCode without restarting it),
**"Restart OpenCode"**, and an **OpenCode version check + "Update OpenCode"**
(both behind a warning, since they interrupt an in-flight turn).

OpenCode is updated in **its own environment** (so an nvm/PATH wrapper is
honoured). By default it runs `<opencode-bin> upgrade`; override with
`--opencode-update-cmd` on the client daemon for custom setups, e.g.
`--opencode-update-cmd 'bash -lc "nvm use 20 && npm i -g opencode-ai@latest"'`.
