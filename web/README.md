# vh-solara web UI

SolidJS + Vite. Lightweight by design (no virtual DOM; heavy rendering —
markdown, syntax highlight, diffs — is done by the daemon, see
`docs/architecture/04-render-pipeline.md`). The client consumes the daemon's resumable
sync protocol (`docs/architecture/03-stateful-aggregator.md`).

## Build (produces the embedded UI)

```bash
cd web
npm install
npm run build      # emits into ../web/dist-build (staging); run make build to materialize + embed
```

A plain `go build` embeds the committed fallback placeholder banner at
`pkg/web/dist/index.html` (self-contained, no Node toolchain required), NOT the
real SPA. `pkg/web/dist/index.html` is committed only as that fallback;
`web/dist-build/` is gitignored. Run `make build` to materialize the staged SPA
into `pkg/web/dist/` and embed the real UI (the tag-driven release workflow does
this automatically).

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
