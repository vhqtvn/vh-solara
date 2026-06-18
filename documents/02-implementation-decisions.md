# Implementation Decisions

During the development of the MVP for `vh-solara`, several design logic patterns and choices were made to optimize proxy speed and logic efficiency natively in Go.

## 1. Single Binary Abstraction
Using `spf13/cobra`, the entire suite of agent and server functionalities are bundled within the root `./vh-solara` process, which determines its runtime environment through subcommands (e.g. `server` and `agent`).

## 2. Remote Proxy Implementation
To seamlessly intercept HTTP/REST/SSE calls to an OpenCode runner located securely on completely isolated hardware behind a firewall:
1. `Tunnel Transport`: The `WebSockets` module is used with `gorilla/websocket` since it intrinsically handles long-lived two-way connections perfect for NAT traversal.
2. The agent (`worker`) originates an outbound dial to `/vh-solara/ws` to bypass internal server firewalls.
3. We serialize HTTP calls using a base message definition (with `BodyBase64`) encapsulated strictly within JSON frames.
4. The router uses `sync.Map` to dynamically allocate and cleanup in-memory correlation channels (binding an internally generated `uuid` back to the incoming `http.Request`). Wait times are hardcoded to 30s to simulate timeout semantics transparently.

## 3. Sandboxing & Local Environment Access (`ip netns`)
We are utilizing the underlying host `/usr/local/bin/ip` namespace binaries programmatically via standard `os/exec`. This is simple without needing massive dependencies.
- It is critical that the **agent** needs to run as `root` for default deployment to properly configure and drop into a `tmpfs` namespace utilizing the `lo` loopback hardware. 
- However, we provided a fallback inside `opencode.go` to explicitly skip namespace mounting if `--netns=""` is initialized for graceful local testing workflows.

## 4. UI Pinning & Persistent State
By dropping an explicit HTTP-Only `vh_session` cookie directly mapping to `worker_id` pinning via the main lightweight selector HTTP router `GET /`, the design easily accommodates multiple different user sessions against the same Controller multiplexing multiple separate backend `devboxes`. It stores the mapping utilizing `sync.RWMutex`. In the future, this mapping string key value schema maps exactly perfectly to SQLite/Postgres schemas if required.

## 5. Explicit Trailing Slash Support (Go 1.22)
In modern standard library syntax, specific REST `HandleFunc` endpoints may collide. Specifically, Go 1.22 requires strict routing matching priorities, notably fixing panic conditions around wildcard overlapping `GET /` and `GET /opencode/` via exactly `GET /{$}`.
