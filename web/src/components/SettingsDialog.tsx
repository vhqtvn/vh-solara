import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { setThemeId, theme, THEMES } from "../theme";
import { customFont, font, FONTS, setCustomFont, setFontId } from "../font";
import { hideBuiltin, setHideBuiltin } from "../models";
import { setStreamLive, streamLive, treeDensity, setTreeDensity, uiScale, setUiScale, orientation, setOrientation, MIN_SCALE, MAX_SCALE } from "../prefs";
import { queueMode, setQueueMode } from "../queue";
import { canInstall, installed, isIosSafari, promptInstall } from "../pwa-install";
import { killTerm, listTerms } from "../termApi";
import { agents, selectedAgent, setSelectedAgent } from "../agents";
import QuotaPanel from "./QuotaPanel";
import Icon from "./Icon";
import Select from "./Select";

// "App" (install + orientation) only shows in a plain browser tab — once
// installed, the standalone window doesn't need it.
const sections = () => [
  { id: "appearance", name: "Appearance" },
  { id: "general", name: "General" },
  ...(installed() ? [] : [{ id: "app", name: "App" }]),
  { id: "terminals", name: "Terminals" },
  { id: "usage", name: "Usage" },
  { id: "about", name: "About" },
];

function shortDir(d: string): string {
  const parts = d.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || d;
}

// Sectioned settings (sidebar nav + content), modeled on opencode's
// dialog-settings and openchamber's SettingsView.
export default function SettingsDialog(props: { onClose: () => void }) {
  const [sec, setSec] = createSignal("appearance");
  // UI-zoom slider: only APPLY the zoom on release (change), not on every input
  // — applying live rescales the whole UI (slider included) mid-drag, so the
  // thumb slips out from under the pointer. zoomDraft tracks the in-drag value
  // for the label/thumb; null means "not dragging, show the committed scale".
  const [zoomDraft, setZoomDraft] = createSignal<number | null>(null);
  const zoomValue = () => zoomDraft() ?? uiScale();
  // Terminal sessions (fetched when the Terminals tab is open).
  const [terms, { refetch: refetchTerms }] = createResource(sec, (s) => (s === "terminals" ? listTerms() : Promise.resolve([])));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div class="dialog settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <strong style={{ flex: "1", padding: "0 4px" }}>Settings</strong>
          <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="settings-body">
          <nav class="settings-nav">
            <For each={sections()}>
              {(s) => (
                <button
                  type="button"
                  class="settings-nav-item"
                  classList={{ on: sec() === s.id }}
                  onClick={() => setSec(s.id)}
                >
                  {s.name}
                </button>
              )}
            </For>
          </nav>
          <div class="settings-content">
            <Show when={sec() === "appearance"}>
              <div class="setting-row">
                <label>Theme</label>
                <Select
                  class="theme-select"
                  ariaLabel="Theme"
                  value={theme()}
                  options={THEMES.map((t) => ({ value: t.id, label: t.name }))}
                  onChange={setThemeId}
                />
              </div>
              <p class="setting-hint">Light themes also switch code syntax highlighting.</p>
              <div class="setting-row">
                <label>Session list</label>
                <Select
                  class="theme-select"
                  ariaLabel="Session list density"
                  value={treeDensity()}
                  options={[
                    { value: "compact", label: "Compact (1 line)" },
                    { value: "detailed", label: "Detailed (2 lines)" },
                  ]}
                  onChange={(v) => setTreeDensity(v as "compact" | "detailed")}
                />
              </div>
              <p class="setting-hint">
                Detailed adds a second line per session: running/idle child counts, or — when there are
                none — when it started.
              </p>
              <div class="setting-row">
                <label>Display font</label>
                <Select
                  class="theme-select"
                  ariaLabel="Display font"
                  value={font()}
                  options={FONTS.map((f) => ({ value: f.id, label: f.name }))}
                  onChange={setFontId}
                />
              </div>
              <p class="setting-hint">Non-system fonts load on demand from Google Fonts.</p>
              <div class="setting-row">
                <label>UI zoom</label>
                <div class="zoom-control">
                  <input
                    type="range"
                    aria-label="UI zoom"
                    min={MIN_SCALE}
                    max={MAX_SCALE}
                    step="0.05"
                    value={zoomValue()}
                    onInput={(e) => setZoomDraft(Number(e.currentTarget.value))}
                    onChange={(e) => {
                      setUiScale(Number(e.currentTarget.value));
                      setZoomDraft(null);
                    }}
                  />
                  <button type="button" class="zoom-reset" onClick={() => { setUiScale(1); setZoomDraft(null); }}>
                    {Math.round(zoomValue() * 100)}%
                  </button>
                </div>
              </div>
              <p class="setting-hint">
                Scales the whole interface. On mobile this sets the viewport zoom (pinch-zoom is off, so
                this is how you scale the app). Click the % to reset.
              </p>
              <div class="setting-row">
                <label>Orientation</label>
                <Select
                  class="theme-select"
                  ariaLabel="Screen orientation"
                  value={orientation()}
                  options={[
                    { value: "system", label: "Follow system" },
                    { value: "auto", label: "Autorotate" },
                  ]}
                  onChange={(v) => setOrientation(v as "system" | "auto")}
                />
              </div>
              <p class="setting-hint">
                Follow system respects the device's rotation lock; Autorotate lets the app rotate freely.
                Only effective in the installed app — a browser tab follows the device. See the App tab to install.
              </p>
              <Show when={font() === "custom"}>
                <div class="setting-row">
                  <label>Custom font</label>
                  <input
                    class="theme-select"
                    aria-label="Custom font family"
                    placeholder="e.g. Cascadia Code, Fira Sans"
                    value={customFont()}
                    onInput={(e) => setCustomFont(e.currentTarget.value)}
                  />
                </div>
                <p class="setting-hint">Uses a font installed on your system (no external download).</p>
              </Show>
            </Show>

            <Show when={sec() === "general"}>
              <div class="setting-row">
                <label>Default agent</label>
                <Show when={agents().length > 0} fallback={<span class="setting-hint">No agents loaded.</span>}>
                  <Select
                    class="theme-select"
                    ariaLabel="Default agent"
                    value={selectedAgent()}
                    options={agents().map((a) => ({ value: a.name, label: `@${a.name}` }))}
                    onChange={setSelectedAgent}
                  />
                </Show>
              </div>
              <p class="setting-hint">
                Enter sends · Shift+Enter newline · <code>!cmd</code> runs a shell command ·{" "}
                <code>/undo</code> <code>/redo</code> revert a turn.
              </p>
              <div class="setting-row">
                <label>Hide OpenCode builtin models</label>
                <input
                  type="checkbox"
                  aria-label="Hide builtin models"
                  checked={hideBuiltin()}
                  onChange={(e) => setHideBuiltin(e.currentTarget.checked)}
                />
              </div>
              <p class="setting-hint">
                Hides OpenCode's built-in (default) models from the picker, leaving only your
                configured providers.
              </p>
              <div class="setting-row">
                <label>Live message streaming</label>
                <input
                  type="checkbox"
                  aria-label="Live message streaming"
                  checked={streamLive()}
                  onChange={(e) => setStreamLive(e.currentTarget.checked)}
                />
              </div>
              <p class="setting-hint">
                On: assistant replies render token-by-token as they arrive. Off: each block
                appears only once complete (calmer, fewer reflows).
              </p>
              <div class="setting-row">
                <label>Queue messages while busy</label>
                <input
                  type="checkbox"
                  aria-label="Queue messages while busy"
                  checked={queueMode()}
                  onChange={(e) => setQueueMode(e.currentTarget.checked)}
                />
              </div>
              <p class="setting-hint">
                On: sending while a turn is running queues the message and auto-sends it when the
                turn finishes. Off: sending while busy is rejected.
              </p>
            </Show>

            <Show when={sec() === "app"}>
              <p class="setting-hint">
                Install VHSolara as an app for a standalone window, a home-screen icon, and
                working orientation control (browsers ignore the orientation setting in a tab).
              </p>
              <Show
                when={canInstall()}
                fallback={
                  <p class="setting-hint">
                    {isIosSafari()
                      ? "On iPhone/iPad: tap the Share button, then “Add to Home Screen”."
                      : "Use your browser's menu → “Install app” / “Add to Home screen”. (Not all browsers offer it.)"}
                  </p>
                }
              >
                <button type="button" class="install-app-btn" onClick={() => void promptInstall()}>
                  <Icon name="plus" size={14} /> Install app
                </button>
              </Show>
              <p class="setting-hint">
                The orientation control is under Appearance — it takes effect once installed.
              </p>
            </Show>

            <Show when={sec() === "terminals"}>
              <div class="setting-row" style={{ "justify-content": "space-between" }}>
                <label>Active terminals</label>
                <button type="button" class="theme-select" onClick={() => refetchTerms()}>Refresh</button>
              </div>
              <Show when={(terms() || []).length > 0} fallback={<p class="setting-hint">No active terminal sessions.</p>}>
                <For each={terms()}>
                  {(t) => (
                    <div class="term-sess">
                      <div class="term-sess-head">
                        <span class="term-sess-dir" data-tip={t.dir}>{shortDir(t.dir)}</span>
                        <span class="term-sess-meta">{t.clients} client{t.clients === 1 ? "" : "s"} · {t.cols}×{t.rows} · idle {t.idleSec}s</span>
                        <button type="button" class="term-sess-kill" onClick={async () => { await killTerm(t.dir); refetchTerms(); }}>Kill</button>
                      </div>
                      <Show when={t.preview}>
                        <pre class="term-sess-preview">{t.preview}</pre>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </Show>

            <Show when={sec() === "usage"}>
              <QuotaPanel />
            </Show>

            <Show when={sec() === "about"}>
              <p class="setting-hint">
                <strong>VHSolara</strong> — a lightweight, mobile-first web UI for OpenCode.
              </p>
              <p class="setting-hint">Current theme: {theme()}</p>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
