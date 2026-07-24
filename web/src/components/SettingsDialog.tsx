import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { CUSTOM_FIELDS, customTheme, exportCustomTheme, importCustomTheme, resetCustomTheme, seedCustomFromTheme, setCustomTheme, theme, THEMES } from "../theme";
import ThemePicker from "./ThemePicker";
import { customFont, font, FONTS, monoFont, MONO_FONTS, setCustomFont, setFontId, setMonoFontId } from "../font";
import { hideBuiltin, setHideBuiltin } from "../models";
import { setStreamLive, streamLive, treeDensity, setTreeDensity, uiScale, setUiScale, orientation, setOrientation, MIN_SCALE, MAX_SCALE, chatWidth, setChatWidth, chatBubbles, setChatBubbles, notesEnabled, setNotesEnabled, tabStyle, setTabStyle, perfDiagEnabled, setPerfDiagEnabled, type ChatWidth, type TabStyle } from "../prefs";
import { queueMode, setQueueMode } from "../queue";
import { canInstall, installed, isIosSafari, promptInstall } from "../pwa-install";
import { runDiagnostics, chipLabel, type DiagnosticsResult } from "../pwa-diagnostics";
import { killTerm, listTerms } from "../termApi";
import { agents, selectedAgent, setSelectedAgent } from "../agents";
import { displayName } from "../projectSettings";
import QuotaPanel from "./QuotaPanel";
import NotificationsSettings from "./NotificationsSettings";
import { modal } from "../lib/a11y";
import Icon from "./Icon";
import Select from "./Select";
import styles from "./SettingsDialog.module.css";

// "App" (install + orientation) only shows in a plain browser tab — once
// installed, the standalone window doesn't need it.
const sections = () => [
  { id: "theme", name: "Theme" },
  { id: "appearance", name: "Appearance" },
  { id: "notifications", name: "Notifications" },
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
  const [sec, setSec] = createSignal("theme");
  // UI-zoom slider: only APPLY the zoom on release (change), not on every input
  // — applying live rescales the whole UI (slider included) mid-drag, so the
  // thumb slips out from under the pointer. zoomDraft tracks the in-drag value
  // for the label/thumb; null means "not dragging, show the committed scale".
  const [zoomDraft, setZoomDraft] = createSignal<number | null>(null);
  const zoomValue = () => zoomDraft() ?? uiScale();
  // Custom-theme export/import scratch state (null = idle, else a transient note).
  const [importText, setImportText] = createSignal("");
  const [themeNote, setThemeNote] = createSignal<{ ok: boolean; msg: string } | null>(null);
  const copyTheme = async () => {
    try {
      await navigator.clipboard.writeText(exportCustomTheme());
      setThemeNote({ ok: true, msg: "Copied theme to clipboard." });
    } catch {
      setThemeNote({ ok: false, msg: "Clipboard blocked — copy from the import box instead." });
      setImportText(exportCustomTheme());
    }
  };
  const doImport = () => {
    if (importCustomTheme(importText())) {
      setThemeNote({ ok: true, msg: "Imported theme." });
      setImportText("");
    } else {
      setThemeNote({ ok: false, msg: "Not a valid theme — expected JSON with #rrggbb colors." });
    }
  };
  // Terminal sessions (fetched when the Terminals tab is open).
  const [terms, { refetch: refetchTerms }] = createResource(sec, (s) => (s === "terminals" ? listTerms() : Promise.resolve([])));
  // PWA install diagnostics (computed when the App tab is open). Read-only; no
  // CSRF header needed (it only fetches /manifest.webmanifest). Re-runs on a
  // manual Refresh and whenever the App tab is re-entered. Mirrors the terms
  // resource pattern (source accessor + fetcher, no explicit generic).
  const [diag, { refetch: refetchDiag }] = createResource(sec, (s) =>
    s === "app" ? runDiagnostics() : Promise.resolve<DiagnosticsResult | null>(null),
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div class="dialog settings" role="dialog" aria-label="Settings" use:modal onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <strong style={{ flex: "1", padding: "0 4px" }}>Settings</strong>
          <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class={styles["settings-body"]}>
          <nav class={styles["settings-nav"]}>
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
          <div class={styles["settings-content"]}>
            <Show when={sec() === "theme"}>
              <ThemePicker />
              <p class="setting-hint">Light themes also switch code syntax highlighting.</p>
              <Show when={theme() === "custom"}>
                <div class={styles["custom-theme"]}>
                  <For each={CUSTOM_FIELDS}>
                    {(f) => (
                      <label class={styles["custom-theme-row"]}>
                        <span>{f.label}</span>
                        <input
                          type="color"
                          value={customTheme()[f.key]}
                          onInput={(e) => setCustomTheme({ [f.key]: e.currentTarget.value })}
                        />
                      </label>
                    )}
                  </For>
                  <label class={styles["custom-theme-row"]}>
                    <span>Light mode (syntax + diff colors)</span>
                    <input
                      type="checkbox"
                      checked={customTheme().light}
                      onChange={(e) => setCustomTheme({ light: e.currentTarget.checked })}
                    />
                  </label>
                  <div class={styles["custom-theme-actions"]}>
                    <Select
                      ariaLabel="Start from a preset theme"
                      value=""
                      options={[
                        { value: "", label: "Start from preset…" },
                        ...THEMES.filter((t) => t.id !== "custom").map((t) => ({ value: t.id, label: t.name })),
                      ]}
                      onChange={(v) => {
                        if (v) seedCustomFromTheme(v);
                      }}
                    />
                    <button type="button" class="theme-select" onClick={() => void copyTheme()}>Copy</button>
                    <button type="button" class="theme-select" onClick={() => { resetCustomTheme(); setThemeNote({ ok: true, msg: "Reset to default." }); }}>Reset</button>
                  </div>
                  <div class={styles["custom-theme-import"]}>
                    <input
                      type="text"
                      class="theme-select"
                      aria-label="Import theme JSON"
                      placeholder="Paste theme JSON to import…"
                      value={importText()}
                      onInput={(e) => setImportText(e.currentTarget.value)}
                    />
                    <button type="button" class="theme-select" disabled={!importText().trim()} onClick={doImport}>Import</button>
                  </div>
                </div>
                <p class="setting-hint">
                  Pick the 7 base colors — the rest of the palette derives from them. Start from a preset to fork it,
                  Copy to share the palette, or paste JSON to import.
                </p>
                <Show when={themeNote()}>
                  <p class="setting-hint" classList={{ [styles["setting-err"]]: !themeNote()!.ok }}>{themeNote()!.msg}</p>
                </Show>
              </Show>
            </Show>

            <Show when={sec() === "appearance"}>
              <div class="setting-row">
                <label>Header tabs</label>
                <Select
                  class="theme-select"
                  ariaLabel="Header tab style"
                  value={tabStyle()}
                  options={[
                    { value: "labels", label: "Labels" },
                    { value: "icons", label: "Icons" },
                    { value: "dropdown", label: "Dropdown" },
                  ]}
                  onChange={(v) => setTabStyle(v as TabStyle)}
                />
              </div>
              <p class="setting-hint">
                How the Chat/Changes/Code/… view tabs render. Labels &amp; Icons collapse extras into a
                “⋯” menu when they don’t fit; Dropdown is a single compact selector.
              </p>
              <div class="setting-row">
                <label>Chat width</label>
                <Select
                  class="theme-select"
                  ariaLabel="Chat width"
                  value={chatWidth()}
                  options={[
                    { value: "comfortable", label: "Comfortable" },
                    { value: "wide", label: "Wide" },
                    { value: "full", label: "Full width" },
                  ]}
                  onChange={(v) => setChatWidth(v as ChatWidth)}
                />
              </div>
              <p class="setting-hint">
                Caps the message column and composer width. Wider reclaims the side space a centered
                column wastes on a large monitor; Comfortable keeps a readable line length for prose.
              </p>
              <div class="setting-row">
                <label>Bubble your messages</label>
                <input
                  type="checkbox"
                  aria-label="Bubble your messages"
                  checked={chatBubbles()}
                  onChange={(e) => setChatBubbles(e.currentTarget.checked)}
                />
              </div>
              <p class="setting-hint">
                On: your turns show as a right-aligned bubble (Claude/OpenChamber style). Off: a quiet
                full-width card. The assistant always renders full-width.
              </p>
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
              <p class="setting-hint">
                <em>Note:</em> under tree=2 this density control is currently inert (no effect) — the
                detailed variant for the tree=2 row is a planned, deferred feature. The setting is kept
                as a placeholder.
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
                <label>Code font</label>
                <Select
                  class="theme-select"
                  ariaLabel="Code font"
                  value={monoFont()}
                  options={MONO_FONTS.map((f) => ({ value: f.id, label: f.name }))}
                  onChange={setMonoFontId}
                />
              </div>
              <p class="setting-hint">Non-system fonts load on demand from Google Fonts.</p>
              <div class="setting-row">
                <label>UI zoom</label>
                <div class={styles["zoom-control"]}>
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
                  <button type="button" class={styles["zoom-reset"]} onClick={() => { setUiScale(1); setZoomDraft(null); }}>
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

            <Show when={sec() === "notifications"}>
              <NotificationsSettings />
            </Show>

            <Show when={sec() === "general"}>
              <div class="setting-row">
                <label>Notes tab</label>
                <input
                  type="checkbox"
                  aria-label="Enable Notes tab"
                  checked={notesEnabled()}
                  onChange={(e) => setNotesEnabled(e.currentTarget.checked)}
                />
              </div>
              <p class="setting-hint">
                Shows the Notes tab globally. Off by default. A repo can override per-project by setting
                <code>"notes": true</code> in <code>.vh-solara/project.jsonc</code>.
              </p>
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
              <div class="setting-row">
                <label>Show performance diagnostics</label>
                <input
                  type="checkbox"
                  aria-label="Show performance diagnostics"
                  checked={perfDiagEnabled()}
                  onChange={(e) => setPerfDiagEnabled(e.currentTarget.checked)}
                />
              </div>
              <p class="setting-hint">
                Off by default. When on, adds a "Performance" entry to the server-admin menu
                (right-click / long-press Settings → Diagnostics) that shows the always-on server
                latency probes (ingest, emit, stream, yamux, websocket write) and lets you copy
                them for reporting. Collection is always on and low-overhead (most hot paths are
                atomic/lock-free; the tunnel write path samples a lock-free global active-stream
                gauge per write and defers its only per-session yamux read to threshold-gated
                slow-write incidents); this only adds the viewer.
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
                <button type="button" class={styles["install-app-btn"]} onClick={() => void promptInstall()}>
                  <Icon name="plus" size={14} /> Install app
                </button>
              </Show>
              <p class="setting-hint">
                The orientation control is under Appearance — it takes effect once installed.
              </p>

              {/* Install diagnostics panel — renders BELOW the install button.
                  Pure read-only observability: every signal JS can see is shown
                  as a row, then a single likely-cause interpretation, then the
                  honest "cannot be checked from JS" callouts. See
                  web/src/pwa-diagnostics.ts for the computation. */}
              <div class={styles["pwa-diag"]}>
                <div class={styles["pwa-diag-head"]}>
                  <strong class={styles["pwa-diag-title"]}>Install diagnostics</strong>
                  <button type="button" class={styles["pwa-diag-refresh"]} onClick={() => refetchDiag()}>Refresh</button>
                </div>
                <Show when={!diag() && diag.loading}>
                  <p class="setting-hint">Gathering install signals…</p>
                </Show>
                <Show when={diag()}>
                  {(d) => (
                    <>
                      <For each={d().signals}>
                        {(row) => (
                          <div class={styles["pwa-diag-row"]}>
                            <span class={styles["pwa-diag-label"]}>{row.label}</span>
                            <span class={styles["pwa-diag-chip"]} data-status={row.status}>{chipLabel(row.status)}</span>
                            <span class={styles["pwa-diag-value"]}>
                              {row.value}
                              <Show when={row.detail}><span class={styles["pwa-diag-detail"]}> · {row.detail}</span></Show>
                            </span>
                          </div>
                        )}
                      </For>
                      <div class={styles["pwa-diag-cause"]}>
                        <strong>Likely cause: </strong>{d().likelyCause}
                      </div>
                      <div class={styles["pwa-diag-callouts"]}>
                        <strong>Cannot be checked from JS:</strong>
                        <ul>
                          <For each={d().cannotObserve}>{(c) => <li>{c}</li>}</For>
                        </ul>
                      </div>
                      <p class={styles["pwa-diag-note"]}>{d().webapkNote}</p>
                    </>
                  )}
                </Show>
              </div>
            </Show>

            <Show when={sec() === "terminals"}>
              <div class="setting-row" style={{ "justify-content": "space-between" }}>
                <label>Active terminals</label>
                <button type="button" class="theme-select" onClick={() => refetchTerms()}>Refresh</button>
              </div>
              <Show when={(terms() || []).length > 0} fallback={
                terms.loading
                  ? <p class="setting-hint">Loading terminals…</p>
                  : <p class="setting-hint">No active terminal sessions.</p>
              }>
                <For each={terms()}>
                  {(t) => (
                    <div class={styles["term-sess"]}>
                      <div class={styles["term-sess-head"]}>
                        <span class={styles["term-sess-dir"]} data-tip={t.dir}>{shortDir(t.dir)}</span>
                        <span class={styles["term-sess-meta"]}>
                          {t.title ? displayName(t.title) : (t.id === "shared" ? "Shell" : t.id)} · {t.clients} client{t.clients === 1 ? "" : "s"} · {t.cols}×{t.rows} · idle {t.idleSec}s
                        </span>
                        <button type="button" class={styles["term-sess-kill"]} onClick={async () => { await killTerm(t.dir, t.id); refetchTerms(); }}>Kill</button>
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
