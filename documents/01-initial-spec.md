# vh-solara: Centralized Remote Control for OpenCode

## Goal

Build a system that lets a user manage and control OpenCode sessions running on multiple developer machines from one central place, with OpenChamber as the main UI.

The system must avoid exposing OpenCode on the host network of worker machines. Worker-side OpenCode instances should run inside a private network namespace or equivalent isolated container/network sandbox. Only a worker daemon may communicate outward.

## Summary

The system has three parts:

1. **Worker daemon (`vh-solara-agent`)** running as root on each developer machine.
2. **Central controller server** running on a trusted server.
3. **OpenChamber UI** pointed at the controller, not directly at worker machines.

The controller presents a stable OpenCode-compatible HTTP/SSE endpoint to OpenChamber. Internally, the controller proxies requests to the selected worker over a persistent outbound WebSocket tunnel established by each worker daemon.

## Core design constraints

* No OpenCode TCP port may be exposed on the host network namespace of the worker machine.
* Worker machines initiate outbound connections only.
* OpenChamber should use one stable backend URL.
* Switching workers should happen in the controller routing layer, without restarting OpenChamber.
* The first implementation should be intentionally simple and hackable.
* Prefer transparent proxying of OpenCode behavior over inventing a large parallel API.
* The entire system must be delivered as a **single binary** with subcommands.
* The worker -> controller WebSocket is expected to pass through **nginx**.
* The user may add extra auth gates in nginx, such as auth headers, special headers, path prefixes, or auth_request logic.
* The controller itself is assumed to be served only behind nginx; direct public exposure is not required for MVP.

## Non-goals

* Do not build a full multi-tenant SaaS.
* Do not replace OpenCode functionality.
* Do not modify OpenChamber unless strictly necessary.
* Do not support arbitrary inbound connectivity to worker machines.
* Do not require Kubernetes.

---

# 1. High-level architecture

## Worker side

Each developer machine runs `vh-solara agent` as a root-managed service.

Responsibilities:

* Create and manage a private network namespace or equivalent private runtime.
* Start OpenCode server inside that private namespace.
* Ensure OpenCode listens only inside that private namespace.
* Maintain a persistent outbound WebSocket connection to the controller.
* Proxy controller requests to the local OpenCode server through the private channel.
* Report worker health, metadata, and available sessions.

## Controller side

The trusted server runs `vh-solara server` behind nginx.

Responsibilities:

* Accept worker WebSocket tunnels.
* Maintain a registry of live workers.
* Expose a stable OpenCode-compatible HTTP API surface for OpenChamber.
* Expose a stable OpenCode-compatible SSE stream for OpenChamber.
* Route each browser/user session to one selected worker.
* Optionally expose a small management UI/API for worker selection.
* Assume nginx sits in front of it and may enforce additional authentication or request-shaping before requests ever reach the controller.

The central controller:

* Accepts worker WebSocket tunnels.
* Maintains a registry of live workers.
* Exposes a stable OpenCode-compatible HTTP API surface for OpenChamber.
* Exposes a stable OpenCode-compatible SSE stream for OpenChamber.
* Routes each browser/user session to one selected worker.
* Optionally exposes a small management UI/API for worker selection.

## UI side

OpenChamber is configured once to point to the controller:

* `OPENCODE_HOST=https://controller.example.com`
* `OPENCODE_SKIP_START=true`

OpenChamber should never need to know individual worker addresses.

---

# 2. Required user flows

## Flow A: worker boots and registers

1. `vh-solara-agent` starts on machine boot.
2. It creates or joins a private network namespace.
3. It starts OpenCode server inside that namespace.
4. It opens a persistent authenticated WebSocket to the controller.
5. It registers worker metadata.
6. Controller marks the worker online.

## Flow B: user opens OpenChamber

1. User opens OpenChamber.
2. OpenChamber talks to the controller at a fixed URL.
3. User selects a worker from a lightweight selector UI or separate management route.
4. Controller pins that browser session to the chosen worker.
5. All subsequent OpenCode API calls from that browser session are routed to that worker.

## Flow C: live session control

1. OpenChamber requests session list, status, messages, diffs, and events.
2. Controller forwards those requests over the corresponding worker tunnel.
3. Worker daemon proxies the requests to the local OpenCode server.
4. Responses are returned transparently.

## Flow D: worker disconnects

1. Tunnel drops.
2. Controller marks worker offline.
3. Any pinned browser session receives a clear error or offline state.
4. Agent retries connection with backoff.

---

# 3. Worker daemon specification

## Binary name and command model

Use a **single binary** named `vh-solara`.

It must expose subcommands rather than separate executables.

Minimum required subcommands:

* `vh-solara agent` — run the worker daemon on developer machines
* `vh-solara server` — run the central controller server
* `vh-solara health` — print local health/debug info
* `vh-solara version` — print version/build info

Optional but useful subcommands:

* `vh-solara install-agent` — install or print a systemd unit for the worker
* `vh-solara install-server` — install or print a systemd unit for the controller
* `vh-solara netns` — inspect/create/debug the private network namespace
* `vh-solara tunnel-test` — validate worker -> nginx -> server WebSocket connectivity

The implementation may share internal packages/modules, but the deliverable to users must be one binary with subcommands.

## Service model

Run as root via systemd on Linux.

Example service responsibilities:

* Start at boot.
* Restart on failure.
* Keep logs in journald.
* Read config from `/etc/vh-solara/config.yaml` and/or environment.

## Configuration

Proposed config keys:

```yaml
controller_url: https://edge.example.com
worker_id: devbox-01
worker_name: Pi Zero Laptop
auth_token: <secret>
namespace_name: vh-solara
opencode_bin: /usr/local/bin/opencode
opencode_port: 4096
workspace_roots:
  - /home/pi/src
  - /work
heartbeat_interval_sec: 10
reconnect_backoff_sec:
  min: 1
  max: 30

# nginx-facing tunnel options
websocket_path: /vh-solara/ws
extra_headers:
  X-Worker-Token: <secret>
  X-Edge-Key: <secret>
uri_prefix: /private/control
```

Notes:

* `controller_url` should normally point at the **nginx public edge**, not the raw controller listener.
* The agent must support adding arbitrary extra headers to the WebSocket handshake so the user can enforce nginx-side protections.
* The agent should support configurable WebSocket path prefixes because the user may hide the tunnel behind a non-obvious URI.

## Responsibilities

* terminate worker WebSockets
* authenticate workers
* maintain online worker registry
* expose OpenCode-compatible HTTP routes under `/*`
* expose OpenCode-compatible SSE under `/global/event`
* maintain browser-session to worker selection mapping
* optionally expose management routes under `/api/*`
* operate correctly when placed **behind nginx**, including preserved upgrade headers for WebSocket and disabled buffering for SSE where needed

## Edge / nginx assumptions

The implementation should assume the deployment shape:

```text
internet -> nginx -> vh-solara server
```

and for workers:

```text
worker agent -> wss://public-edge/... -> nginx -> vh-solara server
```

The controller does not need to be internet-safe by itself in MVP. The primary external hardening layer is nginx.

The coding agent must design the server so that nginx can enforce additional policies without patching application code, including:

* static secret header checks
* Authorization header checks
* special hidden URI/path prefixes
* IP allowlists
* auth_request integration
* separate public UI and private worker-tunnel locations

The controller should therefore support configurable base paths and should not assume it lives at `/`.

## Storage

A simple SQLite or Postgres database is acceptable.

Minimum persisted data:

* worker_id
* worker_name
* last_seen
* status
* software_version
* tags
* selected metadata

In-memory state:

* active websocket per worker
* pinned UI session -> worker_id mapping
* active request streams

## Suggested management API

### Worker registration

`POST /api/workers/register`

### Heartbeat

`POST /api/workers/heartbeat`

### List workers

`GET /api/workers`

### Select worker for current UI session

`POST /api/ui/select-worker`

### Get current selected worker

`GET /api/ui/current-worker`

## OpenCode-compatible proxy routes

The controller must proxy OpenCode routes as transparently as possible.

At minimum support:

* `GET /global/health`
* `GET /global/event`
* `GET /session`
* `GET /session/status`
* `GET /config`
* other routes needed by OpenChamber after testing

Important: do not over-design. Start by observing which OpenChamber routes are used and support those first.

## Routing rule

For any incoming OpenCode-compatible request from the browser:

1. identify browser session
2. resolve selected worker
3. proxy request over the tunnel to that worker
4. return response

If no worker is selected, return a clear 409 or 400 with a useful message.

---

# 5. Tunnel protocol

Use JSON frames for control and binary frames or chunked text frames for payload streaming if helpful.

First version can use JSON-only if simpler.

## Envelope

```json
{
  "type": "http_request",
  "request_id": "uuid",
  "worker_id": "devbox-01",
  "payload": {}
}
```

## Message types

### register

Worker -> controller

```json
{
  "type": "register",
  "worker_id": "devbox-01",
  "worker_name": "Pi Zero Laptop",
  "version": "0.1.0"
}
```

### heartbeat

Worker -> controller

```json
{
  "type": "heartbeat",
  "worker_id": "devbox-01",
  "timestamp": "2026-03-13T12:00:00Z"
}
```

### http_request

Controller -> worker

```json
{
  "type": "http_request",
  "request_id": "req-123",
  "method": "GET",
  "path": "/session",
  "query": "",
  "headers": {
    "accept": "application/json"
  },
  "body_base64": ""
}
```

### http_response

Worker -> controller

```json
{
  "type": "http_response",
  "request_id": "req-123",
  "status": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body_base64": "...",
  "done": true
}
```

### sse_open

Controller -> worker

```json
{
  "type": "sse_open",
  "request_id": "sse-1",
  "path": "/global/event"
}
```

### sse_event

Worker -> controller

```json
{
  "type": "sse_event",
  "request_id": "sse-1",
  "event": "message",
  "data": "...raw or encoded event payload..."
}
```

### sse_close

Either direction

```json
{
  "type": "sse_close",
  "request_id": "sse-1"
}
```

### error

Either direction

```json
{
  "type": "error",
  "request_id": "req-123",
  "code": "UPSTREAM_UNAVAILABLE",
  "message": "OpenCode backend is offline"
}
```

## Design notes

* Keep the protocol narrow.
* Do not invent domain-specific objects yet.
* Treat the tunnel as a remote transport for OpenCode HTTP/SSE.

---

# 6. Security requirements

## Worker security

* Worker daemon runs as root only because it manages the network namespace.
* OpenCode must not be reachable from the host namespace.
* Tunnel must be outbound TLS only.
* Use per-worker auth token.
* Keep OpenCode backend auth enabled anyway as defense in depth.

## Controller security

* Require authentication for management APIs.
* Separate worker auth from UI auth.
* Log worker registrations and selection changes.
* Do not allow one UI session to access another worker without explicit selection.

## Secrets

* Store worker token in root-readable config only.
* Support token rotation later.

---

# 7. OpenChamber integration

## Expected integration mode

Run OpenChamber separately, ideally in Docker, pointed at the controller **through nginx**:

```bash
OPENCODE_HOST=https://edge.example.com
OPENCODE_SKIP_START=true
```

OpenChamber should talk to the public edge URL. nginx then proxies to `vh-solara server`.

## Important constraint

Do not restart OpenChamber to switch workers.

Instead:

* browser calls controller management route to select worker
* controller updates session pinning
* subsequent OpenChamber requests transparently hit the selected worker

## Optional selector UX

Implement a small page or lightweight route outside OpenChamber for selecting the active worker.

Examples:

* `/select-worker`
* small top bar injected by reverse proxy later if needed
* separate admin page

First version can be a minimal plain HTML page.

---

# 8. MVP scope

## Must have

* worker daemon service
* private network namespace per worker
* OpenCode started inside the namespace
* persistent worker -> controller WebSocket
* controller worker registry
* controller session pinning to selected worker
* proxy for basic OpenCode HTTP routes
* proxy for OpenCode SSE route
* OpenChamber working through controller for one selected worker

## Nice to have

* automatic worker discovery page
* multiple tags per worker
* worker labels like laptop, desktop, gpu, prod
* reconnect diagnostics
* controller metrics
* software version reporting

## Not in MVP

* multi-user RBAC
* terminal multiplexing separate from OpenCode
* file upload/download extras
* distributed scheduling
* full audit system

---

# 10. Acceptance criteria

A build is acceptable when all of the following are true:

1. On a worker machine, no OpenCode port is visible in the host network namespace.
2. `vh-solara-agent` starts OpenCode inside a private network namespace.
3. The worker automatically appears in the controller after boot.
4. OpenChamber is configured once against the controller URL.
5. A user can select worker A and see/control its OpenCode sessions.
6. The same user can switch to worker B without restarting OpenChamber.
7. OpenCode SSE events continue working through the controller.
8. If a worker disconnects, the UI surfaces an understandable offline state.

---

# 14. One-sentence directive for the coding agent

Build a single-binary system named `vh-solara` with `agent` and `server` subcommands, where worker agents run OpenCode inside a private network namespace, connect outbound to the server over an nginx-compatible authenticated WebSocket, and the server exposes one stable OpenCode-compatible endpoint behind nginx for OpenChamber, with worker selection handled entirely in the controller and no OpenCode port exposed on the host network namespace of worker machines.
