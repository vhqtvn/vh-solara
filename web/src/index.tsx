import { render } from "solid-js/web";
import App from "./App";
import { startSync } from "./sync";
import { loadModels } from "./models";
import { loadAgents } from "./agents";
import { applyTheme } from "./theme";
import { applyFont } from "./font";
import { applyScale, applyOrientation } from "./prefs";
import { registerServiceWorker, startVersionCheck } from "./pwa";
import { initPwaInstall } from "./pwa-install";
import { installCsrf } from "./csrf";
import { installViewport } from "./viewport";
import "./styles.css";

installCsrf(); // must run before any fetch
installViewport();
applyTheme();
applyFont();
applyScale();
applyOrientation();
startSync();
void loadModels();
void loadAgents();
registerServiceWorker();
startVersionCheck();
initPwaInstall();
render(() => <App />, document.getElementById("root")!);
