import { render } from "solid-js/web";
import App from "./App";
import StandaloneCode from "./components/StandaloneCode";
import { startSync } from "./sync";
import { loadModels } from "./models";
import { loadAgents } from "./agents";
import { applyTheme } from "./theme";
import { applyFont } from "./font";
import "./prefs"; // import for side effect: DOM-affecting prefs apply reactively on load
import { registerServiceWorker, startVersionCheck } from "./pwa";
import { initPwaInstall } from "./pwa-install";
import { installCsrf } from "./csrf";
import { installViewport } from "./viewport";
import { installScrollEdges } from "./lib/scrollEdges";
import { startPresence } from "./alerts";
import "./styles.css";

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
  registerServiceWorker();
  startVersionCheck();
  initPwaInstall();
  startPresence();
  render(() => <App />, root);
  installScrollEdges();
}
