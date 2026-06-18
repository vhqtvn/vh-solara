import { createResource, createSignal, For, Show } from "solid-js";
import { oc } from "../api";
import { state } from "../sync";

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
              <span class="m-prov srv-val">{r.v}</span>
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
        <Show when={mcpRows().length > 0} fallback={<div class="placeholder">None configured.</div>}>
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
        <Show when={lspRows().length > 0} fallback={<div class="placeholder">None active.</div>}>
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
        <Show when={plugins().length > 0} fallback={<div class="placeholder">None installed.</div>}>
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
