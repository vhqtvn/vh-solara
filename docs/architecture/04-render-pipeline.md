# Server-Side Render Pipeline

## Why

The expensive work in a chat UI is not the framework — it is markdown parsing,
syntax highlighting (loading grammars + themes), and diff rendering, multiplied
across a long history. Doing that in a phone browser is what made OpenChamber
sluggish and caused post-layout height changes (async highlight → reflow → scroll
jump). So the daemon renders this content to HTML in Go; the phone just paints it.

## What renders where

- **Settled content** (completed text/code blocks, finished diffs): rendered by
  the daemon, cached by content hash, served as HTML. This is the 100+ message
  backlog — heights are stable on first paint, no client CPU.
- **In-flight streaming content** (the one assistant message currently growing):
  rendered by the client itself. It is a single small, growing message, so client
  cost is negligible, and the daemon avoids re-rendering on every token delta.
  When it settles, the client requests the daemon-rendered HTML.

The client owns the "settled vs in-flight" decision because it knows what is on
screen; the daemon stays a pure, cacheable render function.

## Endpoints (`pkg/render` behind `pkg/web`)

### `POST /vh/render`
Batch. The client sends all settled, visible, not-yet-cached items in one call:
```json
[ { "id": "<stable id, e.g. partID+hash>", "kind": "markdown", "text": "…" },
  { "id": "…", "kind": "diff", "file": "main.go", "before": "…", "after": "…" } ]
```
Response:
```json
[ { "id": "…", "html": "<sanitized html>" }, … ]
```
Markdown is GFM + class-based chroma highlighting, sanitized with bluemonday
(scripts stripped, `javascript:` URIs removed, chroma `class` attributes kept).
Diffs are line-level unified HTML (`.vh-diff-add` / `.vh-diff-del` / context),
content HTML-escaped.

### `GET /vh/highlight.css`
The chroma stylesheet for the active theme (class mode), fetched once and cached
(`Cache-Control: max-age=86400`). Required for highlighted code to be colored.

## Client caching

Results are deterministic in their inputs, so the client caches rendered HTML by
content hash in IndexedDB. Steady-state cost: render each unique block once, ever.
The daemon also keeps a bounded in-memory LRU keyed by the same hash.

## Notes / future

- Diff uses an LCS line alignment (O(n·m) space) — fine for OpenCode's modest
  FileDiffs; revisit if very large files appear.
- Theme is fixed to `github-dark` for v1; making it configurable is a later knob.
- Diff syntax highlighting (per-language coloring inside diffs) is deferred.
