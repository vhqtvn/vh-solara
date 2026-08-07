import { render } from "solid-js/web";
import { App } from "./App";
import "dockview-core/dist/styles/dockview.css";
import "./styles/tokens.css";
import "./styles/pane.css";
import "./dockview/dockviewOverrides.css";

const root = document.getElementById("root")!;
render(() => <App />, root);
