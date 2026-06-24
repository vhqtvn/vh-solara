import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { createStore } from "solid-js/store";
import Select from "./Select";
import Icon from "./Icon";
import {
  deviceName,
  setDeviceName,
  scope,
  setScope,
  notifSupported,
  osPerm,
  enableOSNotifications,
} from "../alerts";
import {
  getAlertConfig,
  saveAlertConfig,
  setActiveProfile,
  sendTestChannel,
  type AlertConfig,
  type AlertChannel,
  type ChannelType,
  type DeviceScope,
} from "../alertsApi";

const POLICY_LABEL: Record<string, string> = {
  always: "always",
  when_unattended: "when I'm away",
  never: "never",
};

// Settings → Notifications. Three groups: this device (local delivery), the
// active profile (routing preset), and channels (outbound webhooks). Detection
// thresholds live under an "Advanced" disclosure.
export default function NotificationsSettings() {
  const [cfg, { mutate, refetch }] = createResource<AlertConfig | null>(getAlertConfig);
  const [draft, setDraft] = createStore<{ channels: AlertChannel[] }>({ channels: [] });
  const [dirty, setDirty] = createSignal(false);
  const [note, setNote] = createSignal<{ ok: boolean; msg: string } | null>(null);
  const [advanced, setAdvanced] = createSignal(false);
  const config = () => cfg();

  // Seed the editable channel draft when the loaded config changes identity
  // (load, save, profile switch) — NOT on every keystroke (draft edits don't
  // change cfg() identity), so in-progress edits survive.
  createEffect(on(cfg, (c) => {
    if (c) {
      setDraft("channels", c.channels.map((ch) => ({ ...ch })));
      setDirty(false);
    }
  }));

  const switchProfile = async (name: string) => {
    const ok = await setActiveProfile(name);
    if (ok) mutate((c) => (c ? { ...c, active_profile: name } : c));
    setNote(ok ? null : { ok: false, msg: "Could not switch profile." });
  };

  const addChannel = () => {
    const n = draft.channels.length + 1;
    setDraft("channels", (xs) => [
      ...xs,
      { id: `channel-${n}`, type: "generic", url: "", enabled: true, hasSecret: false, secret: "", command: "", args: [] },
    ]);
    setDirty(true);
  };
  const removeChannel = (i: number) => {
    setDraft("channels", (xs) => xs.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const editChannel = (i: number, patch: Partial<AlertChannel>) => {
    setDraft("channels", i, patch);
    setDirty(true);
  };

  const save = async () => {
    const c = config();
    if (!c) return;
    const next: AlertConfig = { ...c, channels: draft.channels };
    const saved = await saveAlertConfig(next);
    if (saved) {
      mutate(saved);
      setDraft("channels", saved.channels.map((ch) => ({ ...ch })));
      setDirty(false);
      setNote({ ok: true, msg: "Saved." });
    } else {
      setNote({ ok: false, msg: "Save failed." });
    }
  };

  const test = async (id: string) => {
    const isCmd = draft.channels.find((c) => c.id === id)?.type === "command";
    setNote({ ok: true, msg: isCmd ? "Running command…" : "Sending test…" });
    const r = await sendTestChannel(id);
    if (r.ok) {
      setNote({ ok: true, msg: isCmd ? "Command ran (exit 0)." : `Test sent (HTTP ${r.status}).` });
    } else {
      setNote({ ok: false, msg: `Test failed: ${r.error || r.status}` });
    }
  };

  const saveDetect = async (patch: Partial<AlertConfig["detect"]>) => {
    const c = config();
    if (!c) return;
    const next: AlertConfig = { ...c, detect: { ...c.detect, ...patch } };
    const saved = await saveAlertConfig(next);
    if (saved) mutate(saved);
  };

  return (
    <div class="notif-settings">
      <Show when={config()} fallback={<p class="setting-hint">Loading…</p>} keyed>
        {(c) => {
          const activeProfile = () => c.profiles.find((p) => p.name === c.active_profile);
          return (
            <>
              {/* This device --------------------------------------------------- */}
              <h4 class="settings-group-title">This device</h4>
              <div class="setting-row">
                <label>Device name</label>
                <input
                  class="theme-select"
                  aria-label="Device name"
                  value={deviceName()}
                  onInput={(e) => setDeviceName(e.currentTarget.value)}
                />
              </div>
              <div class="setting-row">
                <label>Notify on this device</label>
                <Select
                  class="theme-select"
                  ariaLabel="Device notification scope"
                  value={scope()}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "current", label: "Current session only" },
                    { value: "all", label: "All sessions" },
                  ]}
                  onChange={(v) => setScope(v as DeviceScope)}
                />
              </div>
              <p class="setting-hint">
                Controls in-app and OS notifications on THIS browser/PWA. Leave the app open (even
                backgrounded) to receive OS notifications while away.
              </p>
              <Show when={notifSupported} fallback={<p class="setting-hint">OS notifications aren't supported here.</p>}>
                <div class="setting-row">
                  <label>OS notifications</label>
                  <Show
                    when={osPerm() !== "granted"}
                    fallback={<span class="notif-ok">Enabled</span>}
                  >
                    <button
                      type="button"
                      class="btn"
                      disabled={osPerm() === "denied"}
                      onClick={() => void enableOSNotifications()}
                    >
                      {osPerm() === "denied" ? "Blocked in browser" : "Enable"}
                    </button>
                  </Show>
                </div>
              </Show>

              {/* Active profile ------------------------------------------------ */}
              <h4 class="settings-group-title">Active profile</h4>
              <div class="setting-row">
                <label>Profile</label>
                <Select
                  class="theme-select"
                  ariaLabel="Active notification profile"
                  value={c.active_profile}
                  options={c.profiles.map((p) => ({ value: p.name, label: p.name }))}
                  onChange={(v) => void switchProfile(v)}
                />
              </div>
              <Show when={activeProfile()}>
                {(p) => (
                  <p class="setting-hint">
                    Webhook channels fire <strong>{POLICY_LABEL[p().channel_policy] || p().channel_policy}</strong>.
                    Switch profiles to flip routing (e.g. “Away” fires channels always; “Silent” stops everything).
                  </p>
                )}
              </Show>

              {/* Channels ------------------------------------------------------ */}
              <h4 class="settings-group-title">Alert channels</h4>
              <For each={draft.channels} fallback={<p class="setting-hint">No channels yet.</p>}>
                {(ch, i) => (
                  <div class="notif-channel">
                    <div class="setting-row">
                      <input
                        class="theme-select"
                        aria-label="Channel name"
                        placeholder="name"
                        value={ch.id}
                        onInput={(e) => editChannel(i(), { id: e.currentTarget.value })}
                        style={{ "max-width": "9rem" }}
                      />
                      <Select
                        class="theme-select"
                        ariaLabel="Channel type"
                        value={ch.type}
                        options={[
                          { value: "generic", label: "Webhook" },
                          { value: "command", label: "Local command" },
                        ]}
                        onChange={(v) => editChannel(i(), { type: v as ChannelType })}
                      />
                      <input
                        type="checkbox"
                        aria-label="Channel enabled"
                        checked={ch.enabled}
                        onChange={(e) => editChannel(i(), { enabled: e.currentTarget.checked })}
                      />
                      <button type="button" class="icon-btn" aria-label="Remove channel" onClick={() => removeChannel(i())}>
                        <Icon name="x" />
                      </button>
                    </div>

                    <Show
                      when={ch.type === "command"}
                      fallback={
                        <>
                          <input
                            class="theme-select notif-wide"
                            aria-label="Webhook URL"
                            placeholder="https://… (or ${VH_ALERT_URL})"
                            value={ch.url}
                            onInput={(e) => editChannel(i(), { url: e.currentTarget.value })}
                          />
                          <input
                            class="theme-select notif-wide"
                            type="password"
                            aria-label="HMAC secret"
                            placeholder={ch.hasSecret ? "•••••• (unchanged — type to replace)" : "HMAC secret (optional)"}
                            value={ch.secret || ""}
                            onInput={(e) => editChannel(i(), { secret: e.currentTarget.value })}
                          />
                        </>
                      }
                    >
                      <input
                        class="theme-select notif-wide"
                        aria-label="Command"
                        placeholder="/path/to/notify.sh (or ${VH_ALERT_CMD})"
                        value={ch.command || ""}
                        onInput={(e) => editChannel(i(), { command: e.currentTarget.value })}
                      />
                      <input
                        class="theme-select notif-wide"
                        aria-label="Command arguments"
                        placeholder="arguments, space-separated (optional)"
                        value={(ch.args || []).join(" ")}
                        onInput={(e) => editChannel(i(), { args: e.currentTarget.value.split(/\s+/).filter(Boolean) })}
                      />
                    </Show>

                    <div class="setting-row">
                      <button
                        type="button"
                        class="btn"
                        onClick={() => void test(ch.id)}
                        disabled={ch.type === "command" ? !ch.command : !ch.url}
                      >
                        Send test
                      </button>
                    </div>
                  </div>
                )}
              </For>
              <div class="setting-row">
                <button type="button" class="btn" onClick={addChannel}>+ Add channel</button>
                <Show when={dirty()}>
                  <button type="button" class="btn btn-primary" onClick={() => void save()}>Save changes</button>
                </Show>
              </div>
              <p class="setting-hint">
                <strong>Webhook:</strong> the notice is POSTed as JSON; with a secret set, requests carry an
                <code> X-VH-Signature: sha256=… </code> HMAC over the body.
                <br />
                <strong>Local command:</strong> the program runs on the daemon with the notice in its
                environment — <code>VH_ALERT_TYPE</code>, <code>VH_ALERT_TITLE</code>, <code>VH_ALERT_PROJECT</code>,
                <code>VH_ALERT_DETAIL</code>, <code>VH_ALERT_SESSION</code>, <code>VH_ALERT_ROOT</code>,
                <code>VH_ALERT_TS</code>, and <code>VH_ALERT_JSON</code>.
                <br />
                Use <code>${"{VH_ALERT_*}"}</code> in any field to read it from the daemon's environment instead of
                storing it in the file.
              </p>

              {/* Advanced ------------------------------------------------------ */}
              <button type="button" class="notif-advanced-toggle" onClick={() => setAdvanced((v) => !v)}>
                <span class="notif-caret" classList={{ open: advanced() }}><Icon name="chevronDown" size={13} /></span>
                Detection thresholds
              </button>
              <Show when={advanced()}>
                <DetectRow label="Finished settle (s)" value={c.detect.finished_settle_sec} onSave={(v) => saveDetect({ finished_settle_sec: v })} />
                <DetectRow label="Stuck thinking after (s)" value={c.detect.think_sec} onSave={(v) => saveDetect({ think_sec: v })} />
                <DetectRow label="Runaway command after (s)" value={c.detect.command_sec} onSave={(v) => saveDetect({ command_sec: v })} />
                <DetectRow label="Stalled after (s)" value={c.detect.stalled_sec} onSave={(v) => saveDetect({ stalled_sec: v })} />
                <DetectRow label="Channel cooldown (s)" value={c.detect.cooldown_sec} onSave={(v) => saveDetect({ cooldown_sec: v })} />
                <DetectRow label="Idle / away after (s)" value={c.detect.idle_sec} onSave={(v) => saveDetect({ idle_sec: v })} />
                <p class="setting-hint">
                  These run on the daemon for every project. A session that is delegating (a running
                  sub-task or a busy child) never triggers “stuck” or “stalled”.
                </p>
              </Show>

              <Show when={note()}>
                {(n) => <p class="setting-note" classList={{ ok: n().ok, err: !n().ok }}>{n().msg}</p>}
              </Show>
              <Show when={!cfg.loading && !config()}>
                <p class="setting-note err">
                  Alerts engine unavailable. <button type="button" class="link-btn" onClick={() => void refetch()}>Retry</button>
                </p>
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

function DetectRow(props: { label: string; value: number; onSave: (v: number) => void }) {
  const [v, setV] = createSignal(props.value);
  return (
    <div class="setting-row">
      <label>{props.label}</label>
      <input
        class="theme-select"
        type="number"
        min="1"
        aria-label={props.label}
        value={v()}
        onInput={(e) => setV(Number(e.currentTarget.value))}
        onChange={() => props.onSave(v())}
        style={{ "max-width": "6rem" }}
      />
    </div>
  );
}
