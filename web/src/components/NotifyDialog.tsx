import { createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useBackEntry } from "../lib/backStack";
import { modal } from "../lib/a11y";
import Icon from "./Icon";
import styles from "./NotifyDialog.module.css";

// Push-notification admin (slice S3 of the Android-push program; server
// side landed in S1/S2 — pkg/server/notify_http.go, notify_history.go,
// notify_watcher.go). Reached from the hidden server-admin menu
// (right-click / long-press Settings → VH Solara Server → "Push
// notifications"), beside "Fleet status". Manages the device token
// registry and shows the delivery history.
//
// Wire contract (mirror of pkg/server — FROZEN from S1/S2):
//   GET    /vh/notify/tokens            → {schema, tokens:[masked]} —
//     409 when no --notify-store: the WHOLE dialog then flips to the
//     read-only posture + the off-hint (family convention: an empty
//     list would read as "zero devices", which is a lie).
//   POST   /vh/notify/tokens {token,label?} (CSRF) → 201 {created:true}
//     / 200 {created:false} (idempotent re-registration).
//   PATCH  /vh/notify/tokens/{id} {label?, scope?} (CSRF) — scope is
//     WHOLESALE: BOTH enabled and conditions required when present;
//     conditions [] MEANS ALL NINE KINDS (there is no "none" on the
//     wire — the scope editor's empty-selection confirm says exactly
//     that, honestly).
//   DELETE /vh/notify/tokens/{id} (CSRF) → 204. Unrecoverable: the
//     device must re-enroll — the delete confirm says so.
//   POST   /vh/notify/test {token}|{id} (CSRF) → 200 {schema, sent,
//     transport, error?}; 429 + Retry-After when the 10s-per-controller
//     rate limit trips (body names the wait); 409 names
//     --notify-fcm-credentials when no transport is configured.
//   GET    /vh/notify/history?since&limit → {schema, events:[…
//     ascending…], first_id, last_id}. Rendered NEWEST-FIRST (reversed
//     client-side); deliveries carry token IDs only (never raw tokens).
//
// Client validation MIRRORS the server token rules (printable-ASCII
// 0x21–0x7E, 16..2048 bytes; label ≤ 64 code points) for immediate
// feedback — UX sugar only; the server 400 is always surfaced verbatim.
//
// Like FleetStatusDialog: portaled to <body>, lifted above the admin
// popup via var(--z-modal); the admin menu stays mounted behind it (its
// dismiss guard knows about us). Escape is LAYERED: the scope editor
// closes first, then an open delete-confirm, then the dialog.

interface TokenWire {
  id: string;
  label: string;
  token_preview: string;
  created_at: string;
  last_used_at: string | null;
  last_error: string;
  scope: { enabled: boolean; conditions: string[] };
}

interface DeliveryWire {
  token_id: string;
  ok: boolean;
  error?: string;
  retired?: boolean;
}

interface EventWire {
  id: number;
  ts: string;
  kind: string;
  action: string; // appeared | changed | cleared
  count: number;
  title: string;
  body: string;
  deliveries: DeliveryWire[];
}

interface TokensResponse {
  schema?: number;
  tokens?: TokenWire[];
}

interface HistoryResponse {
  schema?: number;
  events?: EventWire[];
}

interface TestResponse {
  schema?: number;
  sent?: boolean;
  transport?: string;
  error?: string;
}

// The nine fleet condition kinds (single source of truth:
// pkg/server status.go fleetConditionOrder) in canonical order, with
// their human phrases (conditionPhrase mirror) for the scope editor.
const CONDITIONS = [
  "permission_pending",
  "question_pending",
  "worker_down",
  "worker_missing",
  "project_missing",
  "session_error",
  "session_retry",
  "session_unread",
  "session_done",
] as const;

const CONDITION_LABELS: Record<string, string> = {
  permission_pending: "permission pending",
  question_pending: "question pending",
  worker_down: "worker down",
  worker_missing: "worker missing",
  project_missing: "project not running",
  session_error: "session error",
  session_retry: "session retrying",
  session_unread: "unread",
  session_done: "finished",
};

// Client mirrors of the server token/label rules (validNotifyToken /
// validateNotifyLabel in pkg/server/notify_store.go). Returns null when
// acceptable, a short message when not.
function validateTokenClient(tok: string): string | null {
  if (tok.length < 16 || tok.length > 2048) {
    return `token length ${tok.length} outside the 16..2048 byte bounds`;
  }
  for (let i = 0; i < tok.length; i++) {
    const c = tok.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) {
      return `token byte at offset ${i} is not printable ASCII (tokens are opaque printable-ASCII strings; no whitespace or controls)`;
    }
  }
  return null;
}

function validateLabelClient(label: string): string | null {
  return [...label].length > 64 ? "label exceeds the 64-code-point limit" : null;
}

// Parse a JSON response defensively: a 200 whose body is NOT JSON (a
// misrouted proxy / worker SPA fallback) must surface as a clean error,
// never a raw JSON.parse exception (FleetStatusDialog hardening).
async function parseJSON<T>(r: Response): Promise<T> {
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Unexpected response from server (not JSON; HTTP ${r.status})`);
  }
}

async function errText(r: Response): Promise<string> {
  return (await r.text()).trim() || `HTTP ${r.status}`;
}

function shortDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

// Bounded verbatim error text (the server already truncates at 512
// bytes; this is a display guard for pathological store entries).
function clampText(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

function scopeSummary(conditions: string[]): string {
  return conditions.length === 0 ? "all events" : `${conditions.length} of 9 events`;
}

// One per-row inline note (test-send results, mutation refusals).
interface RowNote {
  ok: boolean;
  text: string;
}

export default function NotifyDialog(props: { onClose: () => void }) {
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [disabled, setDisabled] = createSignal(false);
  const [tokens, setTokens] = createSignal<TokenWire[]>([]);

  const [histLoading, setHistLoading] = createSignal(false);
  const [histError, setHistError] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal<EventWire[]>([]);
  const newestFirst = createMemo(() => [...history()].reverse());

  // Add-device form.
  const [newToken, setNewToken] = createSignal("");
  const [newLabel, setNewLabel] = createSignal("");
  const [addError, setAddError] = createSignal<string | null>(null);
  const [addNote, setAddNote] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [rawTest, setRawTest] = createSignal<RowNote | null>(null);

  // Per-row interaction state.
  const [acting, setActing] = createSignal<string | null>(null);
  const [rowNotes, setRowNotes] = createSignal<Record<string, RowNote>>({});
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [scopeDraft, setScopeDraft] = createSignal<{
    id: string;
    enabled: boolean;
    on: Record<string, boolean>;
  } | null>(null);
  const [confirmEmptyScope, setConfirmEmptyScope] = createSignal(false);
  const [scopeError, setScopeError] = createSignal<string | null>(null);

  // Expandable history deliveries (one event at a time).
  const [openEvent, setOpenEvent] = createSignal<number | null>(null);

  function noteRow(id: string, ok: boolean, text: string): void {
    setRowNotes((prev) => ({ ...prev, [id]: { ok, text } }));
  }

  // --- Loads -----------------------------------------------------------------

  async function fetchTokens(): Promise<void> {
    const r = await fetch("/vh/notify/tokens");
    if (r.status === 409) {
      setDisabled(true); // honest posture: no --notify-store
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const parsed = await parseJSON<TokensResponse>(r);
    if (!Array.isArray(parsed?.tokens)) throw new Error("unexpected tokens response shape");
    setTokens(parsed.tokens);
  }

  async function loadHistory(): Promise<void> {
    setHistLoading(true);
    setHistError(null);
    try {
      const r = await fetch("/vh/notify/history?limit=50");
      if (r.status === 409) {
        setDisabled(true); // registry off ⇒ history 409s too
        return;
      }
      if (!r.ok) {
        setHistError(`HTTP ${r.status}`);
        return;
      }
      const parsed = await parseJSON<HistoryResponse>(r);
      if (!Array.isArray(parsed?.events)) throw new Error("unexpected history response shape");
      setHistory(parsed.events);
    } catch (e) {
      setHistError(e instanceof Error ? e.message : String(e));
    } finally {
      setHistLoading(false);
    }
  }

  async function load(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      await fetchTokens();
      if (!disabled()) await loadHistory();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  onMount(() => void load());

  // --- Shared mutation plumbing ----------------------------------------------

  // After any mutation lands, re-GET the list so the UI reflects the
  // persisted state exactly as the server serves it.
  async function refreshTokens(): Promise<void> {
    try {
      await fetchTokens();
    } catch (e) {
      // The mutation itself succeeded; a refresh failure is surfaced but
      // never unwinds anything.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  // Test-send response → one honest note line. 200 reports PROVIDER
  // ACCEPTANCE (sent/transport) or the sanitized error verbatim; 429
  // carries the server's wait hint (+ Retry-After when present); other
  // refusals surface verbatim (409 names --notify-fcm-credentials).
  async function testResultNote(r: Response): Promise<RowNote> {
    if (r.status === 429) {
      const after = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
      const body = (await r.text()).trim() || `HTTP ${r.status}`;
      return { ok: false, text: body + (after ? ` (retry after ${after}s)` : "") };
    }
    if (!r.ok) return { ok: false, text: await errText(r) };
    const v = await parseJSON<TestResponse>(r);
    if (v.sent) return { ok: true, text: `✓ Sent via ${v.transport ?? "?"}` };
    return { ok: false, text: `✗ ${v.error || "send failed"}` };
  }

  // --- Add device --------------------------------------------------------------

  async function addDevice(): Promise<void> {
    setAddError(null);
    setAddNote(null);
    const tok = newToken();
    const label = newLabel();
    const bad = validateTokenClient(tok);
    if (bad) {
      setAddError(bad);
      return;
    }
    const badLabel = validateLabelClient(label);
    if (badLabel) {
      setAddError(badLabel);
      return;
    }
    setAdding(true);
    try {
      const r = await fetch("/vh/notify/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ token: tok, label }),
      });
      if (r.status === 409) {
        setDisabled(true);
        return;
      }
      if (!r.ok) {
        setAddError(await errText(r)); // server 400 verbatim
        return;
      }
      const v = await parseJSON<{ created?: boolean }>(r);
      setAddNote(v.created === false ? "Already registered — existing entry kept" : "✓ Device added");
      setNewToken("");
      setNewLabel("");
      await refreshTokens();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  // Raw-token test from the Add section: verifies push BEFORE
  // registering (paste a token from the app, press Test).
  async function testRaw(): Promise<void> {
    setRawTest(null);
    const tok = newToken();
    const bad = validateTokenClient(tok);
    if (bad) {
      setRawTest({ ok: false, text: `✗ ${bad}` });
      return;
    }
    setAdding(true);
    try {
      const r = await fetch("/vh/notify/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ token: tok }),
      });
      setRawTest(await testResultNote(r));
    } catch (e) {
      setRawTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(false);
    }
  }

  // --- Per-row operations --------------------------------------------------------

  async function toggleEnabled(row: TokenWire): Promise<void> {
    setActing(row.id);
    try {
      const r = await fetch(`/vh/notify/tokens/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        // Wholesale scope: BOTH members, conditions carried as stored.
        body: JSON.stringify({
          scope: { enabled: !row.scope.enabled, conditions: row.scope.conditions },
        }),
      });
      if (r.status === 409) {
        setDisabled(true);
        return;
      }
      if (!r.ok) {
        noteRow(row.id, false, await errText(r));
        return;
      }
      await refreshTokens();
    } catch (e) {
      noteRow(row.id, false, e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  function openScope(row: TokenWire): void {
    setScopeError(null);
    setConfirmEmptyScope(false);
    // conditions [] = all nine → all boxes checked.
    const on: Record<string, boolean> = {};
    for (const c of CONDITIONS) {
      on[c] = row.scope.conditions.length === 0 || row.scope.conditions.includes(c);
    }
    setScopeDraft({ id: row.id, enabled: row.scope.enabled, on });
  }

  function closeScope(): void {
    setScopeDraft(null);
    setConfirmEmptyScope(false);
    setScopeError(null);
  }

  const draftAllOn = () =>
    scopeDraft() !== null && CONDITIONS.every((c) => scopeDraft()!.on[c]);

  function setDraftCond(c: string, v: boolean): void {
    setScopeDraft((d) => (d ? { ...d, on: { ...d.on, [c]: v } } : d));
  }

  function setDraftAll(v: boolean): void {
    setScopeDraft((d) => {
      if (!d) return d;
      const on: Record<string, boolean> = {};
      for (const c of CONDITIONS) on[c] = v;
      return { ...d, on };
    });
  }

  function setDraftEnabled(v: boolean): void {
    setScopeDraft((d) => (d ? { ...d, enabled: v } : d));
  }

  // Save → PATCH wholesale. ALL nine selected sends the canonical []
  // (= all kinds). ZERO selected cannot be expressed as "none" on the
  // wire — [] would mean ALL — so it requires the explicit confirm
  // (confirmEmptyScope) whose text states exactly that.
  async function saveScope(confirmEmpty: boolean): Promise<void> {
    const d = scopeDraft();
    if (!d) return;
    const sel = CONDITIONS.filter((c) => d.on[c]);
    if (sel.length === 0 && !confirmEmpty) {
      setConfirmEmptyScope(true);
      return;
    }
    const conditions = sel.length === CONDITIONS.length ? [] : sel;
    setActing(d.id);
    try {
      const r = await fetch(`/vh/notify/tokens/${d.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ scope: { enabled: d.enabled, conditions } }),
      });
      if (r.status === 409) {
        setDisabled(true);
        return;
      }
      if (!r.ok) {
        setScopeError(await errText(r));
        return;
      }
      closeScope();
      await refreshTokens();
    } catch (e) {
      setScopeError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  async function deleteToken(row: TokenWire): Promise<void> {
    setActing(row.id);
    try {
      const r = await fetch(`/vh/notify/tokens/${row.id}`, {
        method: "DELETE",
        headers: { "X-VH-CSRF": "1" },
      });
      if (r.status === 409) {
        setDisabled(true);
        return;
      }
      if (!r.ok) {
        noteRow(row.id, false, await errText(r));
        return;
      }
      setConfirmDelete(null);
      await refreshTokens();
    } catch (e) {
      noteRow(row.id, false, e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  async function testRow(row: TokenWire): Promise<void> {
    setActing(row.id);
    try {
      const r = await fetch("/vh/notify/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ id: row.id }),
      });
      const note = await testResultNote(r);
      noteRow(row.id, note.ok, note.text);
    } catch (e) {
      noteRow(row.id, false, e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  // Browser back closes the dialog (mobile/PWA posture); Esc and the
  // overlay click close it too. Escape is LAYERED: the scope editor
  // closes first, then an open delete-confirm, then the dialog.
  useBackEntry(props.onClose, "notify");
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (scopeDraft()) {
      closeScope();
      return;
    }
    if (confirmDelete()) {
      setConfirmDelete(null);
      return;
    }
    props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <Portal>
      <div class="dialog-overlay" classList={{ [styles.overlay]: true }} onClick={props.onClose}>
        <div
          use:modal
          class="dialog"
          classList={{ [styles.dialog]: true }}
          role="dialog"
          aria-label="Push notifications"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="dialog-head">
            <span class="dialog-title">
              <Icon name="bell" size={15} /> Push notifications
            </span>
            <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>

          <div class="dialog-body">
            <Show when={loading()}>
              <div class={styles.status}>Loading…</div>
            </Show>
            <Show when={loadError()}>
              <div class={styles.err}>Couldn't load the notification registry ({loadError()}).</div>
              <button type="button" class="btn" onClick={() => void load()}>
                Retry
              </button>
            </Show>

            <Show when={!loading() && !loadError()}>
              <Show when={disabled()}>
                <div class={styles.off}>
                  Push notifications are off — start the server with{" "}
                  <code>--notify-store &lt;path&gt;</code> to manage device tokens and keep a
                  delivery history. (Test sends additionally need{" "}
                  <code>--notify-fcm-credentials</code>.)
                </div>
              </Show>

              <Show when={!disabled()}>
                {/* ── Devices ──────────────────────────────────────────── */}
                <section>
                  <div class={styles.secHead}>
                    <h3 class={styles.secTitle}>Devices</h3>
                  </div>
                  <Show when={tokens().length === 0}>
                    <div class={styles.empty}>
                      No devices registered — enroll one below or from the Android app.
                    </div>
                  </Show>
                  <Index each={tokens()}>
                    {(t, i) => {
                      const row = t;
                      const note = () => rowNotes()[row().id];
                      return (
                        <div class={styles.dev}>
                          <div class={styles.devTop}>
                            <span class={styles.devName}>{row().label || "Unlabeled device"}</span>
                            <span class={styles.mono} title="masked token">
                              {row().token_preview}
                            </span>
                            <span class={styles.devDate}>{shortDate(row().created_at)}</span>
                            <span
                              class={styles.badge}
                              classList={{
                                [styles.badgeOn]: row().scope.enabled,
                                [styles.badgeOff]: !row().scope.enabled,
                              }}
                            >
                              {row().scope.enabled ? "on" : "off"} ·{" "}
                              {scopeSummary(row().scope.conditions)}
                            </span>
                          </div>
                          <div class={styles.devSub}>
                            <Show
                              when={row().last_used_at}
                              fallback={<span class={styles.dim}>never used</span>}
                            >
                              used {shortDate(row().last_used_at!)}
                            </Show>
                            <Show when={row().last_error}>
                              {" · "}
                              <span class={styles.errText} title={row().last_error}>
                                last error: {clampText(row().last_error)}
                              </span>
                            </Show>
                          </div>
                          <div class={styles.devActions}>
                            <button
                              type="button"
                              class={styles.mini}
                              disabled={acting() === row().id}
                              aria-label={`Device ${i + 1} ${row().scope.enabled ? "disable" : "enable"}`}
                              onClick={() => void toggleEnabled(row())}
                            >
                              {row().scope.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              class={styles.mini}
                              aria-label={`Device ${i + 1} scope`}
                              onClick={() => openScope(row())}
                            >
                              <Icon name="edit" size={12} /> Scope
                            </button>
                            <button
                              type="button"
                              class={styles.mini}
                              disabled={acting() === row().id}
                              aria-label={`Device ${i + 1} test`}
                              onClick={() => void testRow(row())}
                            >
                              <Icon name="send" size={12} /> Test
                            </button>
                            <button
                              type="button"
                              class={styles.miniDanger}
                              aria-label={`Device ${i + 1} delete`}
                              title="Delete"
                              onClick={() => setConfirmDelete(row().id)}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </div>

                          <Show when={confirmDelete() === row().id}>
                            <div class={styles.warnBox}>
                              ⚠ Delete this device? The registration token cannot be recovered —
                              the device must re-enroll from the app.
                              <div class={styles.warnBtns}>
                                <button
                                  type="button"
                                  class={styles.miniDanger}
                                  disabled={acting() === row().id}
                                  onClick={() => void deleteToken(row())}
                                >
                                  Delete permanently
                                </button>
                                <button
                                  type="button"
                                  class={styles.mini}
                                  onClick={() => setConfirmDelete(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </Show>

                          <Show when={scopeDraft()?.id === row().id}>
                            <div class={styles.scopeBox}>
                              <label class={styles.chk}>
                                <input
                                  type="checkbox"
                                  checked={scopeDraft()!.enabled}
                                  onChange={(e) => setDraftEnabled(e.currentTarget.checked)}
                                  aria-label={`Device ${i + 1} enabled`}
                                />
                                Enabled
                              </label>
                              <label class={styles.chkAll}>
                                <input
                                  type="checkbox"
                                  checked={draftAllOn()}
                                  onChange={(e) => setDraftAll(e.currentTarget.checked)}
                                  aria-label={`Device ${i + 1} all events`}
                                />
                                All event kinds
                              </label>
                              <div class={styles.chkGrid}>
                                <Index each={[...CONDITIONS]}>
                                  {(c) => (
                                    <label class={styles.chk}>
                                      <input
                                        type="checkbox"
                                        checked={!!scopeDraft()!.on[c()]}
                                        onChange={(e) => setDraftCond(c(), e.currentTarget.checked)}
                                        aria-label={CONDITION_LABELS[c()]}
                                      />
                                      {CONDITION_LABELS[c()]}
                                    </label>
                                  )}
                                </Index>
                              </div>
                              <Show when={scopeError()}>
                                <div class={styles.err}>⚠ {scopeError()}</div>
                              </Show>
                              <Show when={confirmEmptyScope()}>
                                <div class={styles.warnBox}>
                                  No event kinds selected. The wire has no “none”: an empty list
                                  means ALL nine kinds. To receive nothing, disable the device
                                  instead.
                                  <div class={styles.warnBtns}>
                                    <button
                                      type="button"
                                      class={styles.miniDanger}
                                      disabled={acting() === row().id}
                                      onClick={() => void saveScope(true)}
                                    >
                                      Save empty (all events)
                                    </button>
                                    <button
                                      type="button"
                                      class={styles.mini}
                                      onClick={() => setConfirmEmptyScope(false)}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              </Show>
                              <div class={styles.scopeBtns}>
                                <button type="button" class={styles.mini} onClick={closeScope}>
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  class="btn btn-primary"
                                  disabled={acting() === row().id}
                                  onClick={() => void saveScope(false)}
                                >
                                  {acting() === row().id ? "Saving…" : "Save scope"}
                                </button>
                              </div>
                            </div>
                          </Show>

                          <Show when={note()}>
                            <div classList={{ [styles.note]: true, [styles.noteErr]: !note()!.ok }}>
                              {note()!.text}
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </Index>
                </section>

                {/* ── Add device ─────────────────────────────────────────── */}
                <section>
                  <div class={styles.secHead}>
                    <h3 class={styles.secTitle}>Add device</h3>
                  </div>
                  <div class={styles.addRow}>
                    <input
                      class={styles.inToken}
                      type="text"
                      placeholder="FCM registration token"
                      value={newToken()}
                      onInput={(e) => setNewToken(e.currentTarget.value)}
                      spellcheck={false}
                      aria-label="New device token"
                    />
                    <input
                      class={styles.inLabel}
                      type="text"
                      placeholder="label (optional)"
                      value={newLabel()}
                      onInput={(e) => setNewLabel(e.currentTarget.value)}
                      aria-label="New device label"
                    />
                    <button
                      type="button"
                      class="btn btn-primary"
                      onClick={() => void addDevice()}
                      disabled={adding()}
                    >
                      {adding() ? "Adding…" : "Add device"}
                    </button>
                    <button
                      type="button"
                      class="btn"
                      aria-label="Test unregistered token"
                      title="Send a test push WITHOUT registering the token"
                      onClick={() => void testRaw()}
                      disabled={adding()}
                    >
                      <Icon name="send" size={13} /> Test
                    </button>
                  </div>
                  <Show when={addError()}>
                    <div class={styles.err}>⚠ {addError()}</div>
                  </Show>
                  <Show when={addNote()}>
                    <div class={styles.ok}>{addNote()}</div>
                  </Show>
                  <Show when={rawTest()}>
                    <div classList={{ [styles.note]: true, [styles.noteErr]: !rawTest()!.ok }}>
                      {rawTest()!.text}
                    </div>
                  </Show>
                  <div class={styles.hint}>
                    Test sends to the token above WITHOUT registering it — paste a token from the
                    app to verify push first.
                  </div>
                </section>
              </Show>

              {/* ── History ───────────────────────────────────────────── */}
              <section>
                <div class={styles.secHead}>
                  <h3 class={styles.secTitle}>History</h3>
                  <button
                    type="button"
                    class={styles.addBtn}
                    onClick={() => void loadHistory()}
                    disabled={histLoading() || disabled()}
                  >
                    <Icon name="retry" size={13} /> {histLoading() ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
                <Show when={!disabled()}>
                  <Show when={histError()}>
                    <div class={styles.err}>Couldn't load history ({histError()}).</div>
                  </Show>
                  <Show when={!histError() && history().length === 0}>
                    <div class={styles.empty}>
                      No notifications yet — fleet events pushed to enrolled devices appear here.
                    </div>
                  </Show>
                  <Index each={newestFirst()}>
                    {(e) => {
                      const ev = e;
                      return (
                        <div class={styles.ev}>
                          <div class={styles.evMain}>
                            <span class={styles.evDot} aria-hidden="true" />
                            <span class={styles.evBody}>
                              <span class={styles.evTitle}>
                                {ev().title} — {ev().body}
                              </span>
                              <span class={styles.evKind}>
                                {CONDITION_LABELS[ev().kind] ?? ev().kind}
                              </span>
                            </span>
                            <span
                              class={styles.chip}
                              classList={{
                                [styles.chipAppeared]: ev().action === "appeared",
                                [styles.chipChanged]: ev().action === "changed",
                                [styles.chipCleared]: ev().action === "cleared",
                              }}
                            >
                              {ev().action}
                            </span>
                            <Show when={ev().count > 0}>
                              <span class={styles.evCount}>×{ev().count}</span>
                            </Show>
                            <span class={styles.evTs}>{relTime(ev().ts)}</span>
                            <button
                              type="button"
                              class={styles.delivBtn}
                              aria-label={`Deliveries event ${ev().id}`}
                              aria-expanded={openEvent() === ev().id}
                              title="Deliveries"
                              onClick={() =>
                                setOpenEvent(openEvent() === ev().id ? null : ev().id)
                              }
                            >
                              <Icon name="chevronDown" size={13} />
                            </button>
                          </div>
                          <Show when={openEvent() === ev().id}>
                            <div class={styles.deliv}>
                              <Index each={ev().deliveries}>
                                {(d) => (
                                  <div class={styles.delivRow}>
                                    <span class={styles.mono} title={d().token_id}>
                                      {d().token_id.slice(0, 8)}…
                                    </span>
                                    <Show when={d().retired}>
                                      <span class={styles.retired}>retired (unregistered)</span>
                                    </Show>
                                    <Show when={!d().retired && d().ok}>
                                      <span class={styles.okText}>✓ delivered</span>
                                    </Show>
                                    <Show when={!d().ok && !d().retired}>
                                      <span class={styles.errText}>
                                        {clampText(d().error || "failed")}
                                      </span>
                                    </Show>
                                  </div>
                                )}
                              </Index>
                              <Show when={ev().deliveries.length === 0}>
                                <span class={styles.dim}>
                                  no devices were eligible (scope or disabled)
                                </span>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </Index>
                </Show>
              </section>
            </Show>
          </div>

          <div class={styles.foot}>
            <div class={styles.footHint}>
              Test sends are rate-limited to one per 10 seconds on the server. Registry changes
              persist immediately.
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
