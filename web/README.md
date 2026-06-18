# vh-solara web UI

SolidJS + Vite. Lightweight by design (no virtual DOM; heavy rendering —
markdown, syntax highlight, diffs — is done by the daemon, see
`documents/04-render-pipeline.md`). The client consumes the daemon's resumable
sync protocol (`documents/03-stateful-aggregator.md`).

## Build (produces the embedded UI)

```bash
cd web
npm install
npm run build      # emits into ../pkg/web/dist, which the Go binary embeds
```

Then build the daemon as usual (`go build`). The built `pkg/web/dist` is
committed because the Go binary embeds it via `//go:embed`.

## Dev

```bash
# Point at a running `vh-solara client-daemon --web=vh` web port:
VH_DAEMON=http://127.0.0.1:<port> npm run dev
```

Vite proxies `/vh/*` and `/oc/*` to the daemon, so the SSE stream, snapshot,
render, and passthrough endpoints work against a live backend during dev.

## Layout

- `src/sync.ts` — resumable `/vh/stream` client, Solid store of sessions,
  localStorage hydrate-on-open, visibility/online reconnect.
- `src/components/SessionTree.tsx` — eager session→subsession tree from
  `Session.parentID`.
- `src/components/Sidebar.tsx` — persistent (non-floating) sidebar; off-canvas
  drawer on narrow screens.
- `src/App.tsx` — shell; the chat view mounts in the main pane (next).
