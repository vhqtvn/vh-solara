import { render } from "solid-js/web";
import { createEffect, createRoot, on } from "solid-js";
import App from "./App";
import StandaloneCode from "./components/StandaloneCode";
import { projectDir, startSync, state } from "./sync";
import { agents, loadAgents } from "./agents";
import { loadModels, models } from "./models";
import { pushNotification } from "./notify";
import { applyTheme } from "./theme";
import { applyFont } from "./font";
import "./prefs"; // import for side effect: DOM-affecting prefs apply reactively on load
import { registerServiceWorker, startVersionCheck } from "./pwa";
import { initPwaInstall } from "./pwa-install";
import { installCsrf } from "./csrf";
import { installViewport } from "./viewport";
import { installScrollEdges } from "./lib/scrollEdges";
import { startPresence } from "./alerts";
import { refreshProjectSettings } from "./projectSettings";
import "./styles/main.css";

// Best-effort: re-fire loadAgents()/loadModels() and retry while agents stay
// empty, so a flaky first /oc/agent response (OpenCode not yet connected when
// the stream opened) recovers WITHOUT a page reload. Idempotent — loadAgents
// overwrites agents() and re-resolves the default on every call, and the
// `ensuring` guard keeps concurrent triggers single-flight. Stops as soon as
// agents() populates. This is what un-sticks the "new-session draft shows no
// agent" screen: the boot load bailed silently (agents() left []), and since
// projectDir doesn't change afterward nothing re-triggered it. A rejecting
// fetch is caught and retried the same way — it never mutates agents(), so the
// empty state stays intact and the budget keeps counting down.
let ensuring = false;
async function ensureAgentsLoaded() {
  if (ensuring) return;
  ensuring = true;
  try {
    for (let attempt = 0; attempt < 6 && agents().length === 0; attempt++) {
      try {
        await loadAgents();
      } catch {
        // reject = treat as still empty; continue retry budget
      }
      if (agents().length > 0) break;
      if (attempt < 5) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8000)));
    }
    // Models are best-effort here: sendText fetches them on demand too, but a
    // reload on stream-ready lets the model button appear alongside the agent
    // dropdown and clears the readyToSend gate.
    if (models().length === 0) void loadModels();
    // Only surface a notice once the retry budget is exhausted — avoid spam on
    // transient blips. A later reconnect (status → live) re-runs this and may
    // still recover.
    if (agents().length === 0) {
      pushNotification({
        kind: "info",
        title: "Couldn't load agents",
        detail: "OpenCode may not be connected — will retry on reconnect.",
      });
    }
  } finally {
    ensuring = false;
  }
}

installCsrf(); // must run before any fetch
installViewport();
applyTheme();
applyFont();

const root = document.getElementById("root")!;
const standalone = new URLSearchParams(location.search).get("standalone");

if (standalone === "code") {
  // Code viewer hosted in an iframe by the main app: render ONLY the viewer and
  // skip the full app's session/stream/PWA machinery. The project dir comes from
  // the URL; theme/localStorage is shared same-origin with the parent.
  render(() => <StandaloneCode />, root);
  installScrollEdges();
} else {
  startSync();
  void loadModels();
  void loadAgents();
  // Agents and models are project-scoped (OpenCode resolves them per directory).
  // Reload them when the active project changes so a switch doesn't keep the old
  // project's agent list / models. defer: the initial load is the two calls above.
  createRoot(() =>
    createEffect(on(projectDir, () => { void loadAgents(); void loadModels(); }, { defer: true })),
  );
  // Re-fire agent/model loads when the OpenCode connection becomes live — /oc/*
  // is routable once the tree stream is up. The boot calls above may run before
  // OpenCode is connected and silently bail (agents()/models() left empty);
  // reacting to state.status → "live" is the reliable re-trigger, since both
  // the stream's first open (onopen) and every reconnect set status to "live".
  // defer: the boot calls own the very first attempt; this fires on each
  // connecting→live transition (initial open AND reconnect after a drop).
  // S3 supplement: ALSO re-pull project settings here. refreshProjectSettings
  // otherwise only runs on projectDir change (App.tsx), so a reconnect after a
  // server restart — where the project.jsonc watch EventSource also died and
  // re-opened — could leave agent-style chips stale until a manual reload.
  createRoot(() =>
    createEffect(
      on(
        () => state.status === "live",
        (live, prev) => {
          if (live && !prev) {
            void ensureAgentsLoaded();
            void refreshProjectSettings();
          }
        },
        { defer: true },
      ),
    ),
  );
  registerServiceWorker();
  startVersionCheck();
  initPwaInstall();
  startPresence();
  render(() => <App />, root);
  installScrollEdges();
}
