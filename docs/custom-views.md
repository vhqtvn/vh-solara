# Building a custom view

A **custom view** is your own web app embedded inside vh-solara as a first-class
tab, peer to the chat. You run an ordinary HTTP server (a dashboard, a board, a
log viewer, a docs site, anything); vh-solara **reverse-proxies it under a path
prefix** and renders it in a **sandboxed iframe** that loads same-origin. Your
app inherits vh-solara's host, auth, and TLS — no separate domain, no CORS, no
login of its own.

This document is the **maintained contract** for the consumer side: what you
build, and the limits you build within. Hand it to the repo that implements the
view. For *registering* a view (declaring it in a project, or the HTTP API), see
[managed-projects.md](managed-projects.md); this doc is about the **view app
itself**.

> Maintainers: keep this in sync with the source of truth —
> `pkg/web/views.go` (proxy, CSP, sandbox allow-list, prefix rules),
> `web/src/themeTokens.ts` (the `--vh-*` token contract), and
> `web/src/components/ViewFrame.tsx` (iframe element + theme handshake).

---

## Mental model

```
  browser ── vh-solara origin (auth + TLS) ───────────────────────────┐
    │                                                                  │
    │  <iframe src="/board/">          sandboxed, same-origin          │
    │      │                                                           │
    │      ▼                                                           │
    │   GET /board/        ── vh-solara strips "/board" ──►  your upstream
    │   GET /board/app.js                                    GET /
    │                                                        GET /app.js
    │      ◄── injects <base href="/board/">, CSP, framing ──┘
    └──────────────────────────────────────────────────────────────────
```

- You serve a normal web app at the **root** of your upstream (`/`, `/app.js`,
  `/api/data`).
- vh-solara mounts it under a prefix (`/board`), strips that prefix before
  forwarding, and rewrites HTML/redirects so your **relative** URLs resolve.
- The iframe and your app share vh-solara's origin, so same-origin requests (to
  your own backend, under the prefix) just work; everything external is blocked.

The effective mount path may be namespaced per project (e.g.
`/_p/<hash>/board`) — you never hardcode it. Always use **relative** URLs and let
the injected `<base>` resolve them.

---

## The prefix-correctness contract (read this first)

This is the one rule that breaks views when ignored.

**Serve every asset and link as a relative URL — no leading slash.**

| Do | Don't |
|----|-------|
| `<script src="app.js">` | `<script src="/app.js">` |
| `<link href="style.css">` | `<link href="/style.css">` |
| `fetch("api/data")` | `fetch("/api/data")` |
| `<a href="page2">` | `<a href="/page2">` |

vh-solara helps you in three ways:

1. **Prefix strip** — your upstream receives clean paths (`/`, `/app.js`), so you
   write your server as if it were mounted at root.
2. **`<base>` injection** — `<base href="<prefix>/">` is inserted right after
   `<head>` (or `<html>`, or the start of the document) on every `text/html`
   response, so relative URLs resolve under the prefix in the browser.
3. **Redirect rewriting** — a root-absolute `Location:` header (`/x`) is rewritten
   to `<prefix>/x`.

A **root-absolute URL (`/foo`) bypasses the prefix** and will 404 or hit
vh-solara itself — that's on you to avoid. If you must use absolute URLs, set your
own `<base>` or read the forwarded `X-Forwarded-Prefix` request header and prepend
it server-side.

> HTML over **4 MiB** is streamed through **without** `<base>` injection (a memory
> guard). Keep your entry document small, or set `<base>` yourself.

---

## What can run inside (interactivity & limits)

Custom views support full client-side interactivity — SPAs, frameworks, canvas,
live-updating dashboards — **within a strict same-origin Content-Security-Policy**
that vh-solara sets on every proxied response:

```
default-src 'self';
img-src 'self' data: blob:;  media-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
font-src 'self' data:;  connect-src 'self';
frame-ancestors 'self';  base-uri 'self';  object-src 'none'
```

What this means for you:

| Capability | Allowed? | Notes |
|------------|----------|-------|
| JavaScript (incl. inline + `eval`) | ✅ | Frameworks, bundlers, SPAs all run. |
| `fetch` / `XHR` to **your own** backend | ✅ | Same-origin only (under your prefix), relative URLs. |
| Server-Sent Events (SSE) | ✅ | Proxy flushes immediately (no buffering). |
| WebSocket to **your own** backend | ✅ | Same-origin (`connect-src 'self'`); use a relative/`location`-derived URL. |
| Inline styles & `<style>` | ✅ | `'unsafe-inline'`. |
| Images / media as `data:` / `blob:` | ✅ | Plus same-origin files. |
| Fonts (self-hosted or `data:`) | ✅ | |
| **External** scripts/styles/fonts/CDNs | ❌ | `default-src 'self'`. **Self-host everything.** |
| **External** API calls (other origins) | ❌ | `connect-src 'self'`. Proxy them through your own backend. |
| `<object>` / `<embed>` plugins | ❌ | `object-src 'none'`. |
| Navigating/replacing the **top** page | ❌ | No `allow-top-navigation` in the sandbox. |

**Bottom line:** a custom view is a self-contained, same-origin app. Bundle your
assets, talk only to your own upstream, and proxy any third-party data through it.

### Sandbox

The iframe is sandboxed. The default is `allow-scripts allow-same-origin`
(`allow-same-origin` is required so your app's same-origin requests and storage
work). A registration may opt into a **safe subset** — the only tokens vh-solara
accepts are:

```
allow-scripts  allow-same-origin  allow-forms  allow-popups  allow-modals  allow-downloads
```

Anything else (notably `allow-top-navigation`) is stripped. The view is framed
only by vh-solara (`frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`).

> This sandbox is defense-in-depth for an **operator-registered** upstream you
> control — it is not a hostile-content boundary. Don't embed untrusted code as a
> view.

---

## Auth & cookies

- The view loads **same-origin**, behind vh-solara's auth — the operator is
  already signed in, so your app needs **no login of its own**.
- vh-solara **strips its session cookie and CSRF header** before forwarding, so
  your upstream gets a clean request and never sees vh-solara's credentials.
- Your upstream's **`Set-Cookie` is dropped** — a view **cannot set cookies** on
  the vh-solara origin. Don't rely on cookie-based sessions in the view. Keep
  state server-side (your upstream's own memory/store), in the URL, or in
  `localStorage` (per the same-origin sandbox).
- Identify the project, if you need to: read `X-Forwarded-Prefix` on incoming
  requests — its value encodes your mount path (and, for project-declared views,
  the per-project namespace).

---

## Theming: match the vh-solara palette

vh-solara publishes a **stable, semantic set of `--vh-*` CSS custom properties**
to each embedded view over `postMessage`, so your view renders native to whatever
theme (and light/dark mode) the operator is using — and **restyles live** when
they switch, with no reload.

### The handshake

- **On load and on every theme/mode change**, the parent posts a message to your
  iframe:

  ```jsonc
  {
    "source": "vh-solara",
    "type": "theme",
    "mode": "light",          // or "dark"
    "tokens": { "--vh-bg": "#0d1117", "--vh-fg": "#e6edf3", /* … */ }
  }
  ```

- **You may also pull on demand** — post this to your parent and it replies with a
  `theme` message:

  ```js
  parent.postMessage({ source: "vh-solara", type: "theme-request" }, "*");
  ```

### Token contract

Map these onto your own styles. The `--vh-*` names are the **pinned contract**;
vh-solara's internal variable names are not.

| Token | Role |
|-------|------|
| `--vh-bg` | page background |
| `--vh-surface` | raised/elevated surface (cards, popovers) |
| `--vh-fg` | primary text |
| `--vh-muted` | secondary/dim text |
| `--vh-accent` | accent / primary action |
| `--vh-accent-2` | secondary accent |
| `--vh-border` | borders / dividers |
| `--vh-ok` | success |
| `--vh-warn` | warning |
| `--vh-error` | error / danger |

### Apply it

```js
// In your view app. Verify origin + source before trusting a message.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const d = e.data;
  if (d?.source !== "vh-solara" || d.type !== "theme") return;

  const root = document.documentElement;
  for (const [name, value] of Object.entries(d.tokens)) {
    root.style.setProperty(name, value);
  }
  root.dataset.mode = d.mode; // "light" | "dark" — branch your own styles if needed
});

// Ask for the current theme as soon as you're ready (in case you missed onload):
parent.postMessage({ source: "vh-solara", type: "theme-request" }, "*");
```

```css
:root {
  --vh-bg: #111;   /* fallbacks until the first theme message arrives */
  --vh-fg: #eee;
}
body { background: var(--vh-bg); color: var(--vh-fg); }
.card { background: var(--vh-surface); border: 1px solid var(--vh-border); }
.btn-primary { background: var(--vh-accent); }
```

> Theme is **per client** — each browser/device has its own. Apply the tokens you
> receive to *your* document; never assume a single global theme.

---

## Upstream transport

When you register the view, the upstream is one of:

| Spec | Use |
|------|-----|
| `unix:/path/to.sock` | **Recommended.** A unix domain socket — matches vh-solara's own pattern, no port to manage, not network-reachable. |
| `http://127.0.0.1:PORT` (or `https://`) | A TCP listener. |
| `tcp:host:port` | Shorthand for `http://host:port`. |

Network upstreams are guarded against SSRF: **link-local addresses are blocked**
(notably the cloud-metadata endpoint `169.254.169.254`). Loopback and private-LAN
targets are allowed (this is a single-operator daemon). Prefer a unix socket.

Reserved prefixes you cannot mount under: `/vh`, `/oc`, `/auth`, `/assets`.

---

## Minimal end-to-end example

A self-contained view served from a unix socket.

**`index.html`** (note: every URL relative):

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">   <!-- relative, no leading slash -->
</head>
<body>
  <h1>Build status</h1>
  <ul id="list"></ul>
  <script src="app.js"></script>             <!-- relative -->
</body>
</html>
```

**`app.js`**:

```js
// Theme: adopt vh-solara's palette.
addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.data?.source !== "vh-solara") return;
  if (e.data.type === "theme")
    for (const [k, v] of Object.entries(e.data.tokens))
      document.documentElement.style.setProperty(k, v);
});
parent.postMessage({ source: "vh-solara", type: "theme-request" }, "*");

// Data: only your own backend, relative, same origin.
async function refresh() {
  const r = await fetch("api/builds");          // → proxied to your upstream "/api/builds"
  const builds = await r.json();
  document.getElementById("list").innerHTML =
    builds.map((b) => `<li>${b.name}: ${b.status}</li>`).join("");
}
setInterval(refresh, 2000);
refresh();
```

**Register it** — either declared in the repo (preferred) …

```jsonc
// .vh-solara/project.jsonc
{
  "processes": [
    { "id": "status", "command": "status-server --socket .vh-solara/run/status.sock",
      "readiness": { "unix": ".vh-solara/run/status.sock" } }
  ],
  "views": [
    { "id": "status", "title": "Build status",
      "path_prefix": "/status", "upstream": "unix:.vh-solara/run/status.sock",
      "depends_on": "status" }
  ]
}
```

… or by hand against a running upstream:

```bash
curl -sX POST http://127.0.0.1:PORT/vh/views \
  -H 'Content-Type: application/json' -H 'X-VH-CSRF: 1' \
  -d '{"view_id":"status","title":"Build status",
       "path_prefix":"/status","upstream":"unix:/run/status.sock"}'
```

See [managed-projects.md](managed-projects.md) for the full registration model
(trust gate, readiness probes, lifecycle, per-project namespacing).

---

## Checklist

- [ ] All asset/link/fetch URLs are **relative** (no leading slash).
- [ ] No external resources — scripts, styles, fonts, images, APIs are all
      self-hosted or proxied through your own upstream.
- [ ] No reliance on cookies on the vh-solara origin (they're stripped).
- [ ] Listen for the `theme` `postMessage`; apply `--vh-*` tokens; honor `mode`.
- [ ] Entry HTML under 4 MiB (or you set your own `<base>`).
- [ ] App works mounted at an arbitrary prefix (test behind `/anything/`).
- [ ] Upstream on a unix socket where possible.
