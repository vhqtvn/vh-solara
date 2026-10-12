import { render } from "solid-js/web";
import { App } from "./App";
import { applyHostTheme } from "./theme";
import { ensureNarrowRegistration } from "./swNarrow";
import { installHostViewport } from "./hostViewport";
import "dockview-core/dist/styles/dockview.css";
import "./styles/tokens.css";
import "./styles/pane.css";
import "./dockview/dockviewOverrides.css";

// Apply the persisted HOST theme before first render (the web SPA's
// index.tsx pattern). The inline script in index.html has already set the
// pre-paint class; this re-applies from the same key through the real
// runtime — validating the id, setting the .host-theme-light marker for
// light themes, and cleaning up any stray class the inline script left.
applyHostTheme();

// S3b lever A: register the narrow-scope (/app) service worker BEFORE App
// render (pane creation) so cold panes can be BORN SW-controlled; pane srcs
// await its activation gate (host-web/src/swNarrow.ts — fail-open, bounded).
ensureNarrowRegistration();

// Size the host root to the ACTUALLY visible viewport (--host-h), level-
// triggered, before first paint — 100vh overshoots the screen on mobile
// (large-viewport semantics / dynamic toolbar), clipping every pane's bottom
// (the composer). See host-web/src/hostViewport.ts.
installHostViewport();

const root = document.getElementById("root")!;
render(() => <App />, root);
