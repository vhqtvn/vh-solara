import { createSignal, For, Show } from "solid-js";
import { controlProc, grantTrust, managed, procLogs, refreshManaged, type ProcStatus } from "../managed";
import Icon from "./Icon";

// Trust-review card + processes panel for a repo-declared managed project
// (.vh-solara/project.jsonc). Before any declared command runs, the user must
// approve the exact config (display-before-run); once trusted, this panel
// surfaces process health/logs and start/stop/restart controls.
const STATUS_LABEL: Record<ProcStatus, string> = {
  stopped: "stopped",
  starting: "starting",
  ready: "ready",
  unhealthy: "unhealthy",
  failed: "failed",
};

export default function ManagedPanel(props: { onClose: () => void }) {
  const proj = () => managed();
  const needsTrust = () => proj()?.state === "awaiting-trust" || proj()?.state === "changed";

  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  const [openLog, setOpenLog] = createSignal<string | null>(null);
  const [logText, setLogText] = createSignal("");
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  let rootEl: HTMLDivElement | undefined;
  const onDoc = (e: MouseEvent) => {
    if (rootEl && !e.composedPath().includes(rootEl)) props.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (openLog()) setOpenLog(null);
      else props.onClose();
    }
  };
  // Defer so the opening click doesn't immediately close it.
  setTimeout(() => document.addEventListener("click", onDoc), 0);
  document.addEventListener("keydown", onKey);
  void refreshManaged();

  async function approve() {
    setBusy(true);
    setErr("");
    const ok = await grantTrust();
    setBusy(false);
    if (!ok) setErr("Approval failed (the daemon may not have started the processes).");
  }
  async function run(id: string, action: "start" | "stop" | "restart") {
    setBusy(true);
    const ok = await controlProc(id, action);
    setBusy(false);
    if (!ok) setErr(`Failed to ${action} "${id}".`);
  }
  async function toggleLog(id: string) {
    if (openLog() === id) {
      setOpenLog(null);
      return;
    }
    setOpenLog(id);
    setLogText("loading…");
    setLogText(await procLogs(id));
  }
  function toggleProc(id: string) {
    const s = new Set(expanded());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setExpanded(s);
  }

  return (
    <div class="admin-menu managed-panel" role="dialog" aria-label="Project processes" ref={rootEl}>
      <div class="admin-head">
        Project processes
        <Show when={proj()?.dir}>
          <span class="managed-dir" data-tip={proj()!.dir}>{proj()!.dir}</span>
        </Show>
      </div>

      <Show when={err()}>
        <div class="managed-err">{err()}</div>
      </Show>

      {/* Trust gate: show the EXACT declared config before any command runs. */}
      <Show when={needsTrust() && proj()?.review}>
        <div class="managed-trust">
          <div class="managed-trust-warn">
            <Icon name="info" size={14} />
            {proj()?.state === "changed"
              ? "The project config changed since you last approved it. Re-review before it runs."
              : "This project wants to run commands declared in the repo. Review before approving."}
          </div>
          <For each={proj()!.review!.processes}>
            {(p) => (
              <div class="managed-decl">
                <div class="managed-decl-id">{p.id}</div>
                <code class="managed-cmd">{p.command}</code>
                <div class="managed-meta">
                  <Show when={p.cwd}><span>cwd: {p.cwd}</span></Show>
                  <Show when={p.restart}><span> · restart: {p.restart}</span></Show>
                  <Show when={p.env_keys.length}><span> · env: {p.env_keys.join(", ")}</span></Show>
                </div>
              </div>
            )}
          </For>
          <Show when={(proj()?.review?.views.length ?? 0) > 0}>
            <div class="managed-subhead">Views</div>
            <For each={proj()!.review!.views}>
              {(v) => (
                <div class="managed-decl">
                  <span class="managed-decl-id">{v.id}</span>
                  <code class="managed-cmd">{v.path_prefix} → {v.upstream}</code>
                </div>
              )}
            </For>
          </Show>
          <details class="managed-raw">
            <summary>Raw config</summary>
            <pre>{proj()!.review!.config_json}</pre>
          </details>
          <button type="button" class="admin-btn accent" disabled={busy()} onClick={approve}>
            <Icon name="check" size={14} />
            {busy() ? "Starting…" : proj()?.state === "changed" ? "Re-approve & run" : "Trust & run"}
          </button>
        </div>
      </Show>

      {/* Trusted: live process health + controls. */}
      <Show when={!needsTrust()}>
        <Show when={(proj()?.processes.length ?? 0) === 0}>
          <div class="managed-empty">No declared processes.</div>
        </Show>
        <For each={proj()?.processes ?? []}>
          {(p) => (
            <div class="managed-proc" classList={{ open: expanded().has(p.id) }}>
              <div class="managed-proc-row">
                <button type="button" class="managed-proc-toggle" onClick={() => toggleProc(p.id)} aria-label="Expand">
                  <span class="managed-chev" classList={{ rot: !expanded().has(p.id) }}><Icon name="chevronDown" size={12} /></span>
                </button>
                <span class="managed-proc-id">{p.id}</span>
                <span class="managed-status" classList={{ on: p.status === "ready", bad: p.status === "failed" || p.status === "unhealthy" }}>
                  {STATUS_LABEL[p.status]}
                </span>
                <span class="managed-proc-controls">
                  <Show when={p.status === "stopped" || p.status === "failed"}>
                    <button type="button" class="admin-btn sm" disabled={busy()} onClick={() => run(p.id, "start")}>Start</button>
                  </Show>
                  <Show when={p.status === "starting" || p.status === "ready" || p.status === "unhealthy"}>
                    <button type="button" class="admin-btn sm" disabled={busy()} onClick={() => run(p.id, "stop")}>Stop</button>
                    <button type="button" class="admin-btn sm" disabled={busy()} onClick={() => run(p.id, "restart")}>Restart</button>
                  </Show>
                  <button type="button" class="admin-btn sm" onClick={() => toggleLog(p.id)}>Logs</button>
                </span>
              </div>
              <Show when={expanded().has(p.id)}>
                <div class="managed-proc-detail">
                  <code class="managed-cmd">{p.command}</code>
                  <div class="managed-meta">
                    <Show when={p.pid}><span>pid: {p.pid}</span></Show>
                    <Show when={p.restarts}><span> · restarts: {p.restarts}</span></Show>
                    <Show when={p.exit_code || p.status === "failed" || p.status === "stopped"}><span> · exit: {p.exit_code}</span></Show>
                  </div>
                </div>
              </Show>
              <Show when={openLog() === p.id}>
                <pre class="managed-log">{logText() || "(empty)"}</pre>
              </Show>
            </div>
          )}
        </For>
        <Show when={(proj()?.views.length ?? 0) > 0}>
          <div class="managed-subhead">Views</div>
          <For each={proj()!.views}>
            {(v) => (
              <div class="managed-view">
                <code>{v.path_prefix}</code>
                <span classList={{ bad: v.status === "prefix-conflict" }}>{v.status}</span>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
