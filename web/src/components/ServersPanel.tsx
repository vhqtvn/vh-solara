import { createResource, createSignal, For, Show } from "solid-js";
import { oc } from "../api";
import { state } from "../sync";
import "./ServersPanel.module.css";

// Server / MCP / LSP / Plugins, shown as tabs (mirrors opencode web's server
// popup). Data from /oc/config, /oc/mcp, /oc/lsp.
const TABS = [
  { id: "server", name: "Server" },
  { id: "mcp", name: "MCP" },
  { id: "lsp", name: "LSP" },
  { id: "plugins", name: "Plugins" },
];

export default function ServersPanel() {
  const [tab, setTab] = createSignal("server");
  const [mcp] = createResource(() => oc.get<Record<string, any>>("/mcp"));
  const [lsp] = createResource(() => oc.get<any[]>("/lsp"));
  const [config] = createResource(() => oc.get<any>("/config"));
  const [ocVer] = createResource(() =>
    fetch("/vh/opencode-version").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  );

  const mcpRows = () => Object.entries(mcp() || {}).map(([name, v]) => ({ name, ...(v as any) }));
  const lspRows = () => (Array.isArray(lsp()) ? lsp()! : []);
  const plugins = () => (config()?.plugin as string[]) || [];

  const serverRows = () => {
    const c = config() || {};
    const rows: { k: string; v: string }[] = [];
    const push = (k: string, v: unknown) => {
      if (v !== undefined && v !== null && v !== "") rows.push({ k, v: String(v) });
    };
    push("Connection", state.status);
    // Feature 1 (S1/S3): server generation + staleness. A changed epoch across a
    // live connection means the daemon restarted. Mirrors the connection-health
    // toast; useful here as a persistent diagnostic.
    push("Server epoch", state.epoch);
    // Feature 3 (L1): connection-vs-first-snapshot latency per stream, so an
    // operator can tell a slow connection from a slow first-snapshot arrival.
    // `conn` = EventSource open (pure connection); `snap` = open → first
    // snapshot arrival (end-to-end: server compute + serialize + tunnel transport
    // of the payload through the controller; under refreshOpenSessions fan-out the
    // tunnel transit dominates — server compute itself is sub-20ms). Tree stream
    // = tree+notifications; session stream = the active session's messages. The
    // session line also carries `hydrate` = first snapshot → messages.loaded (the
    // upstream full-fetch wait `snap` is blind to on a cold session): a number =
    // cold fetch took Yms, "warm" = the snapshot already had the full history
    // (instant switch), "…" = cold and still fetching (the stall in progress).
    const latTree = state.connLatency.tree;
    const latSes = state.connLatency.session;
    const fmt = (o?: number, s?: number) =>
      o != null || s != null ? `conn ${o ?? "—"}ms · snap ${s ?? "—"}ms` : "—";
    const fmtSes = (
      o?: number, s?: number, h?: number | "warm",
      f?: number, r?: number,
    ) => {
      const hp = h == null ? "…" : h === "warm" ? "warm" : `${h}ms`;
      const hasAny = o != null || s != null || h != null;
      if (!hasAny) return "—";
      const base = `conn ${o ?? "—"}ms · snap ${s ?? "—"}ms · hydrate ${hp}`;
      // fetch/rec split `hydrate` — only present when the daemon reported it on
      // a cold messages.loaded. "—" = absent (old daemon / warm / still fetching).
      return f != null || r != null
        ? `${base} · fetch ${f ?? "—"}ms / rec ${r ?? "—"}ms`
        : base;
    };
    push("Session latency", fmtSes(latSes.open, latSes.snap, latSes.hydrate, latSes.fetchMs, latSes.reconcileMs));
    push("Theme", c.theme);
    push("Model", c.model);
    push("Small model", c.small_model);
    push("Username", c.username);
    push("Schema", c.$schema);
    return rows;
  };

  return (
    <div class="srv">
      <div class="srv-tabs" role="tablist">
        <For each={TABS}>
          {(t) => (
            <button
              type="button"
              role="tab"
              class="srv-tab"
              classList={{ on: tab() === t.id }}
              aria-selected={tab() === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.name}
            </button>
          )}
        </For>
      </div>

      <Show when={tab() === "server"}>
        <For each={serverRows()}>
          {(r) => (
            <div class="m-row">
              <span class="m-row-main">
                <span class="m-name">{r.k}</span>
              </span>
              <span class="m-prov srv-val" title={r.v}>{r.v}</span>
            </div>
          )}
        </For>
        <div class="m-row">
          <span class="m-row-main"><span class="m-name">OpenCode version</span></span>
          <span class="m-prov srv-val">
            <Show when={ocVer()} fallback={"checking…"}>
              {ocVer()!.running || ocVer()!.installed || "unknown"}
              <Show when={ocVer()!.restartNeeded}> · installed {ocVer()!.installed} (restart to apply)</Show>
              <Show when={!ocVer()!.restartNeeded && ocVer()!.updateAvailable}> → {ocVer()!.latest} available</Show>
            </Show>
          </span>
        </div>
        <p class="setting-hint">
          The daemon proxies a local OpenCode server and aggregates its state. Server actions
          (update / reload / restart) live in the admin popup — right-click or long-press the
          Settings button.
        </p>
      </Show>

      <Show when={tab() === "mcp"}>
        <Show when={mcpRows().length > 0} fallback={
          mcp.loading ? <div class="placeholder">Loading…</div> : <div class="placeholder">None configured.</div>
        }>
          <For each={mcpRows()}>
            {(s) => (
              <div class="m-row">
                <span class="m-row-main">
                  <span class="m-name">{s.name}</span>
                  <span class="m-prov">{s.type || "mcp"}</span>
                </span>
                <span class="m-badges">
                  <span class="badge" classList={{ "b-free": s.status === "connected", "b-status": s.status !== "connected" }}>
                    {s.status || "unknown"}
                  </span>
                </span>
              </div>
            )}
          </For>
        </Show>
      </Show>

      <Show when={tab() === "lsp"}>
        <Show when={lspRows().length > 0} fallback={
          lsp.loading ? <div class="placeholder">Loading…</div> : <div class="placeholder">None active.</div>
        }>
          <For each={lspRows()}>
            {(s: any) => (
              <div class="m-row">
                <span class="m-row-main">
                  <span class="m-name">{s.id || s.name || "lsp"}</span>
                  <span class="m-prov">{(s.extensions || []).join(" ")}</span>
                </span>
                <span class="m-badges">
                  <span class="badge b-free">{s.state || "active"}</span>
                </span>
              </div>
            )}
          </For>
        </Show>
      </Show>

      <Show when={tab() === "plugins"}>
        <Show when={plugins().length > 0} fallback={
          config.loading ? <div class="placeholder">Loading…</div> : <div class="placeholder">None installed.</div>
        }>
          <For each={plugins()}>
            {(p) => (
              <div class="m-row">
                <span class="m-row-main">
                  <span class="m-name m-name-full">{p}</span>
                </span>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
