import { render } from "solid-js/web";
import { App } from "./App";
import { applyHostTheme } from "./theme";
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

const root = document.getElementById("root")!;
render(() => <App />, root);
