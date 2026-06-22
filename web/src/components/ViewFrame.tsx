import type { RegisteredView } from "../views";
import { postThemeTo } from "../themeTokens";

// A consumer-registered embedded view: the worker reverse-proxies the upstream
// under view.path_prefix, so this iframe loads same-origin (inheriting host,
// auth and TLS). Sandboxed — read-only by intent; the worker injects a strict
// CSP + framing headers on the proxied responses. On load we push vh-solara's
// theme tokens so the view can render native to the active palette (live updates
// arrive via broadcastTheme() on theme change — see App).
export default function ViewFrame(props: { view: RegisteredView }) {
  return (
    <iframe
      class="view-frame"
      src={props.view.path_prefix + "/"}
      sandbox={props.view.sandbox || "allow-scripts allow-same-origin"}
      title={props.view.title}
      onLoad={(e) => postThemeTo((e.currentTarget as HTMLIFrameElement).contentWindow)}
    />
  );
}
