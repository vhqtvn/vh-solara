import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { ackSession, createSession, isSending, markSessionIdle, openSession, respondPermission, sessionTodoCounts, sessionWorking, setSelectedId, setSending, state } from "../sync";
import { getScroll, setScroll } from "../lib/scroll";
import { chooseVariant, findModel, loadModels, models, selectionFor } from "../models";
import { loadVersioned, saveVersioned } from "../lib/store";
import { activeAgent, agents, selectAgentForSession, selectedAgent } from "../agents";
import { dequeue, enqueue, queueFor, queueMode, removeQueued } from "../queue";
import { historyAt, historyLen, pushHistory } from "../history";
import { type AcItem, commandSuggestions, fileSuggestions } from "../lib/complete";
import ModelDialog from "./ModelDialog";
import PartView, { ActivityGroup } from "./Part";
import { Deferred } from "./Deferred";

// Eager-mount the last N message rows (the tail you see on open + where new
// messages and the live stream land), so scroll-to-bottom and streaming stay
// correct; older rows mount lazily as they near the viewport (see Deferred).
const EAGER_TAIL = 30;
import QuestionCard from "./QuestionCard";
import Icon from "./Icon";
import BrandMark from "./BrandMark";
import { pushNotification } from "../notify";
import { log } from "../lib/log";
import RelTime from "./RelTime";
import Select from "./Select";

const draftKey = (sid: string) => "vh.draft." + sid;

// Model/agent/variant a prompt is sent with (captured at queue time too).
type QueueConfig = { providerID?: string; modelID?: string; variant?: string; agent?: string };


const escHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

// Inline markdown + token highlighting for one line. Color-only spans (no
// font/size/weight/padding changes) so glyph advances match the textarea and
// the caret never drifts. Precedence: code > link > bold > italic > strike >
// command > mention > path.
function inlineHl(s: string): string {
  const re =
    /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(~~[^~\n]+~~)|((?:^|\s)[!/][\w-]+)|(@[\w./-]+)|([\w.\-]+\/[\w.\-/]*\.[A-Za-z]\w{0,7})/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += escHtml(s.slice(last, m.index));
    const tok = m[0];
    const cls = m[1]
      ? "hl-code"
      : m[2]
        ? "hl-link"
        : m[3]
          ? "hl-strong"
          : m[4]
            ? "hl-em"
            : m[5]
              ? "hl-strike"
              : m[6]
                ? "hl-cmd"
                : m[7]
                  ? "hl-mention"
                  : "hl-path";
    if (m[6] && /^\s/.test(tok)) {
      out += escHtml(tok[0]) + `<span class="${cls}">${escHtml(tok.slice(1))}</span>`;
    } else {
      out += `<span class="${cls}">${escHtml(tok)}</span>`;
    }
    last = m.index + tok.length;
  }
  return out + escHtml(s.slice(last));
}

// Line-level markdown (headings, blockquotes, list markers, fenced code), then
// inline highlighting. Drives the composer highlight mirror.
function highlightInput(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(`<span class="hl-code">${escHtml(line)}</span>`);
      continue;
    }
    if (inFence) {
      out.push(`<span class="hl-code">${escHtml(line)}</span>`);
      continue;
    }
    let mm: RegExpExecArray | null;
    if (/^#{1,6}\s/.test(line)) {
      out.push(`<span class="hl-head">${escHtml(line)}</span>`);
    } else if ((mm = /^(\s*>\s?)([\s\S]*)$/.exec(line))) {
      out.push(`<span class="hl-quote">${escHtml(mm[1])}</span>` + inlineHl(mm[2]));
    } else if ((mm = /^(\s*(?:[-*+]|\d+\.)\s)([\s\S]*)$/.exec(line))) {
      out.push(`<span class="hl-marker">${escHtml(mm[1])}</span>` + inlineHl(mm[2]));
    } else {
      out.push(inlineHl(line));
    }
  }
  return out.join("\n") + "\n"; // trailing line so the mirror height matches the textarea
}

function roleLabel(role?: string): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  return role || "";
}

function messageError(info: any): string | null {
  const e = info?.error;
  if (!e) return null;
  return e.data?.message || e.name || "error";
}

// The model that produced an assistant message, resolved to its display name
// (falling back to the raw id). Empty for non-assistant messages or when the
// message carries no model. message.model uses `modelID`; older/flat envelopes
// put it directly on the info — accept either.
function modelLabel(info: any): string {
  if (info?.role !== "assistant") return "";
  const providerID = info.providerID ?? info.model?.providerID;
  const modelID = info.modelID ?? info.model?.modelID;
  if (!modelID) return "";
  const name = (providerID ? findModel(providerID, modelID)?.name : undefined) || modelID;
  const variant = info.variant ?? info.model?.variant;
  return variant && variant !== "default" ? `${name} · ${variant}` : name;
}

// Assistant cost/token summary, shown once the turn has completed.
function costLabel(info: any): string {
  if (info?.role !== "assistant" || !info?.time?.completed) return "";
  const parts: string[] = [];
  if (typeof info.cost === "number" && info.cost > 0) parts.push(`$${info.cost.toFixed(4)}`);
  const tok = (info.tokens?.input || 0) + (info.tokens?.output || 0);
  if (tok > 0) parts.push(tok >= 1000 ? `${(tok / 1000).toFixed(1)}k tok` : `${tok} tok`);
  return parts.join(" · ");
}

// A permission request's category (e.g. "bash", "edit") for the card header.
function permLabel(p: any): string {
  return String(p?.permission || p?.type || p?.title || "").trim();
}
// The concrete thing being requested — the command / file / description — so the
// user knows what they're approving (OpenCode's payload puts it in metadata or
// the patterns; title/type are usually empty, which is why it read blank).
function permDetail(p: any): string {
  const m = (p?.metadata || {}) as Record<string, any>;
  const cand = m.command ?? m.cmd ?? m.filePath ?? m.path ?? m.description ?? m.title;
  if (typeof cand === "string" && cand.trim()) return cand.trim();
  if (Array.isArray(p?.patterns)) {
    const ps = p.patterns.filter((x: any) => typeof x === "string" && x && x !== "*");
    if (ps.length) return ps.join("\n");
  }
  return "";
}

// Group a message's parts for rendering: consecutive tool/reasoning parts fold
// into one compact "Activity" timeline; text/file parts (and a lone reasoning
// with no tools) render inline as before. Preserves part order.
// RenderItem carries a `key` derived from the part-id composition. The key only
// changes when a part is ADDED/REMOVED — not when a part's text grows — so a
// streaming turn keeps the same keys token-to-token, letting MessageParts reuse
// the row components (parts mutate in place; see upsertPart) instead of
// recreating them every token.
type RenderItem = { kind: "part"; part: any; key: string } | { kind: "activity"; parts: any[]; key: string };
function groupParts(m: any): RenderItem[] {
  const items: RenderItem[] = [];
  let run: any[] = [];
  const flush = () => {
    if (!run.length) return;
    const hasTool = run.some((p) => p?.type === "tool");
    if (run.length === 1 && !hasTool) items.push({ kind: "part", part: run[0], key: "p:" + run[0].id });
    else items.push({ kind: "activity", parts: run, key: "a:" + run.map((p) => p.id).join(",") });
    run = [];
  };
  for (const pid of m.partOrder || []) {
    const p = m.parts[pid];
    if (!p) continue;
    if (p.type === "tool" || p.type === "reasoning") run.push(p);
    else {
      flush();
      items.push({ kind: "part", part: p, key: "p:" + p.id });
    }
  }
  flush();
  return items;
}

// Renders one message's parts. Memoizes the render-items and REUSES the wrapper
// object for an unchanged key, so the row components persist across streaming
// tokens (no flashing/jumping) and update reactively via the in-place part refs.
function MessageParts(props: { m: any; isLastMessage: () => boolean; lastActivityKey: () => string | null }) {
  let cache = new Map<string, RenderItem>();
  const items = createMemo(() => {
    const fresh = groupParts(props.m);
    const next = new Map<string, RenderItem>();
    const out = fresh.map((it) => {
      const reused = cache.get(it.key) ?? it;
      next.set(it.key, reused);
      return reused;
    });
    cache = next;
    return out;
  });
  const settled = () => props.m.info.role === "user" || !!props.m.info.time?.completed;
  const tailId = () =>
    !settled() && props.isLastMessage() ? props.m.partOrder[props.m.partOrder.length - 1] : null;
  return (
    <For each={items()}>
      {(it) =>
        it.kind === "activity" ? (
          <ActivityGroup
            parts={it.parts}
            settled={settled()}
            tailId={tailId()}
            isLast={it.parts[0]?.id === props.lastActivityKey()}
          />
        ) : (
          <PartView part={it.part} settled={settled()} tail={it.part.id === tailId()} />
        )
      }
    </For>
  );
}

export default function ChatView(props: { sessionId: string; draft?: boolean }) {
  let scrollEl: HTMLDivElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  const [following, setFollowing] = createSignal(true);
  // Hide the transcript until it's positioned for the current session, so the
  // initial scroll jump (top → restored/bottom) is never painted — switching
  // sessions reveals the content already in place instead of flashing.
  const [ready, setReady] = createSignal(false);
  const [input, setInput] = createSignal("");
  // Per-session in-flight guard (lives in the sync store, not this reused
  // component) so a send that hangs on one session never blocks another.
  const sending = createMemo(() => isSending(props.sessionId || "draft"));
  // Pending attachments (file parts) to send with the next message.
  interface Attachment { url: string; filename: string; mime: string }
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [uploading, setUploading] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;

  // Load (or switch to) this session's history (drafts have no server session).
  createEffect(() => {
    if (!props.draft && props.sessionId) void openSession(props.sessionId);
  });

  // In a draft, keep the model synced to the selected agent's configured model
  // so a new session starts on the agent's model (applies to "" = the default).
  createEffect(() => {
    if (props.draft) selectAgentForSession("", selectedAgent());
  });

  const sm = () => state.messages[props.sessionId];
  const messages = createMemo(() => {
    const s = sm();
    return s ? s.order.map((id) => s.byId[id]) : [];
  });

  const pendingPermissions = createMemo(() => Object.values(state.permissions[props.sessionId] || {}));
  const pendingQuestions = createMemo(() => Object.values(state.questions[props.sessionId] || {}));

  // A child/subagent session (spawned by a `task` tool) cannot be prompted
  // directly — like opencode web, we disable the composer and offer a jump back
  // to the parent session.
  const parentId = createMemo(() => (props.draft ? undefined : state.sessions[props.sessionId]?.parentID));
  const isChild = createMemo(() => !!parentId());
  function openParent() {
    const pid = parentId();
    if (pid) {
      setSelectedId(pid);
      void openSession(pid);
    }
  }

  // Model selection (per session) + its variants.
  const sel = createMemo(() => selectionFor(props.sessionId));
  const curModel = createMemo(() => {
    const s = sel();
    if (!s) return undefined;
    // Show the selected model even if it isn't in the connected catalog (e.g. a
    // provider that's configured but whose list we don't have) — fall back to a
    // minimal ref showing the model id, so it never reads "Select model" when a
    // model is in fact selected.
    return (
      findModel(s.providerID, s.modelID) ?? {
        providerID: s.providerID,
        modelID: s.modelID,
        provider: s.providerID,
        name: s.modelID,
        label: `${s.providerID} / ${s.modelID}`,
        variants: [],
      }
    );
  });
  const [modelDialog, setModelDialog] = createSignal(false);
  // Variant dropdown value, normalized: "" (the "default" option) unless the
  // session's persisted variant is actually one this model offers — otherwise a
  // stale/literal variant (e.g. "default") matched no option and the control
  // read "Select…" instead of auto-selecting the model default.
  const curVariant = createMemo(() => {
    const v = sel()?.variant;
    return v && curModel()?.variants?.includes(v) ? v : "";
  });

  // "Working" = the session is busy (shared with the sidebar spinner so they
  // always agree). See sessionWorking() for the activity + last-message logic.
  const working = createMemo(() => sessionWorking(props.sessionId));
  // Key (first part id) of the LAST activity group in the whole conversation —
  // that one renders expanded by default, all earlier ones collapsed.
  const lastActivityKey = createMemo(() => {
    const msgs = messages();
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const items = groupParts(msgs[mi]);
      for (let k = items.length - 1; k >= 0; k--) {
        if (items[k].kind === "activity") return (items[k] as any).parts[0]?.id ?? null;
      }
    }
    return null;
  });
  // Agent todo list (OpenCode TodoWrite) → "Tasks N active · M left" pill.
  const todoCounts = createMemo(() => sessionTodoCounts(props.sessionId));
  const todoItems = createMemo(() => (props.sessionId ? state.todos[props.sessionId] || [] : []));
  const [todosOpen, setTodosOpen] = createSignal(false);
  let tasksBarEl: HTMLDivElement | undefined;
  // Close the overlay popover on outside click. Listener lives only while open;
  // onCleanup re-runs when todosOpen flips false, so nothing leaks.
  createEffect(() => {
    if (!todosOpen()) return;
    const onDoc = (e: MouseEvent) => {
      if (tasksBarEl && !e.composedPath().includes(tasksBarEl)) setTodosOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("click", onDoc), 0);
    onCleanup(() => {
      clearTimeout(id);
      document.removeEventListener("click", onDoc);
    });
  });

  function nearBottom() {
    return scrollEl
      ? scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80
      : true;
  }
  function pin() {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }
  function jumpToLatest() {
    setFollowing(true);
    pin();
  }

  // Scroll restore: reopening a session returns to where it was left (else the
  // bottom). `restoredFor` tracks which session we've positioned.
  let restoredFor = "";
  function maybeRestore() {
    if (restoredFor === props.sessionId || !scrollEl) return false;
    restoredFor = props.sessionId;
    const saved = props.draft ? undefined : getScroll(props.sessionId);
    if (saved != null) {
      setFollowing(false);
      scrollEl.scrollTop = Math.min(saved, scrollEl.scrollHeight);
    } else {
      setFollowing(true);
      pin();
    }
    setReady(true); // positioned — safe to reveal
    return true;
  }
  // When the (reused) view switches sessions, save the one we're leaving, arm a
  // restore for the new one, and hide it until that restore positions it.
  createEffect(
    on(
      () => props.sessionId,
      (id, prevId) => {
        if (prevId && scrollEl && restoredFor === prevId) setScroll(prevId, scrollEl.scrollTop);
        restoredFor = "";
        setReady(false);
        // Fallback reveal: if no content change fires the ResizeObserver (so
        // maybeRestore never runs), position + reveal on the next frame anyway.
        requestAnimationFrame(() => {
          if (!ready()) maybeRestore();
        });
        void id;
      },
    ),
  );
  // Re-pin through every height change (new message, streaming tokens, and the
  // raw→rendered-HTML swap) — but only while following. Restore first if pending.
  onMount(() => {
    if (!contentEl) return;
    const ro = new ResizeObserver(() => {
      if (maybeRestore()) return;
      if (following()) pin();
    });
    ro.observe(contentEl);
    onCleanup(() => {
      ro.disconnect();
      if (scrollEl && !props.draft) setScroll(props.sessionId, scrollEl.scrollTop);
    });
  });

  // Scroll handling: track follow state, persist the offset, and mark the
  // session read (ack) when its bottom is reached.
  function onScrolled() {
    const atBottom = nearBottom();
    setFollowing(atBottom);
    if (!props.draft) setScroll(props.sessionId, atBottom ? 0 : scrollEl?.scrollTop ?? 0);
    if (atBottom) ackSession(props.sessionId);
  }

  const [focusMode, setFocusMode] = createSignal(false);

  // Auto-grow the composer up to a cap, then scroll; keep the highlight mirror
  // scrolled in lockstep.
  let taRef: HTMLTextAreaElement | undefined;
  // Prompt-history navigation: -1 = editing the live draft; >=0 = recalled entry.
  let histIdx = -1;
  let histDraft = "";
  let mirrorRef: HTMLDivElement | undefined;
  // Command-palette "Focus composer" action.
  const onFocusComposer = () => taRef?.focus();
  onMount(() => window.addEventListener("vh:focus-composer", onFocusComposer));
  onCleanup(() => window.removeEventListener("vh:focus-composer", onFocusComposer));

  // --- composer autocomplete (@file / @agent / /command) ---------------------
  const [caret, setCaret] = createSignal(0);
  const [acItems, setAcItems] = createSignal<AcItem[]>([]);
  const [acIndex, setAcIndex] = createSignal(0);
  const acOpen = () => acItems().length > 0;
  let acReq = 0; // race guard for async (file) fetches

  // The token under the caret that drives suggestions: a leading "/command", or
  // an "@mention" with no whitespace between the @ and the caret.
  function activeToken(): { type: "command" | "mention"; query: string; start: number; end: number } | null {
    const text = input();
    const c = caret();
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      if (sp === -1 || c <= sp) return { type: "command", query: text.slice(1, c), start: 0, end: c };
    }
    const upto = text.slice(0, c);
    const at = upto.lastIndexOf("@");
    if (at >= 0 && !/\s/.test(upto.slice(at + 1))) {
      return { type: "mention", query: upto.slice(at + 1), start: at, end: c };
    }
    return null;
  }

  // Recompute suggestions whenever the input or caret moves.
  createEffect(() => {
    input();
    caret();
    const tok = activeToken();
    if (!tok || props.draft && tok.type === "command") {
      setAcItems([]);
      return;
    }
    const req = ++acReq;
    setAcIndex(0);
    if (tok.type === "command") {
      void commandSuggestions(tok.query).then((items) => req === acReq && setAcItems(items));
    } else {
      const q = tok.query.toLowerCase();
      const agentItems: AcItem[] = agents()
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 5)
        .map((a) => ({ kind: "agent", label: "@" + a.name, detail: a.description, insert: "@" + a.name + " " }));
      // Show agents immediately; merge in file matches when they arrive.
      setAcItems(agentItems);
      if (tok.query.length >= 1) {
        void fileSuggestions(tok.query).then((files) => req === acReq && setAcItems([...agentItems, ...files]));
      }
    }
  });

  function applyAc(item: AcItem) {
    const tok = activeToken();
    if (!tok) return;
    const text = input();
    const before = text.slice(0, tok.start);
    const after = text.slice(tok.end);
    setInput(before + item.insert + after);
    const pos = (before + item.insert).length;
    setAcItems([]);
    histIdx = -1;
    queueMicrotask(() => {
      if (taRef) {
        taRef.focus();
        taRef.selectionStart = taRef.selectionEnd = pos;
        setCaret(pos);
      }
    });
  }
  const syncCaret = () => taRef && setCaret(taRef.selectionStart ?? 0);

  // Paste clipboard text into the composer. For mobile / no-physical-keyboard
  // where ⌘/Ctrl+V isn't handy; image/file paste still goes through the
  // textarea's onPaste. Reads via the async Clipboard API (needs a user gesture
  // + permission — the tap/hold is the gesture); silently no-ops if
  // denied/unsupported.
  //   - "replace": overwrite the whole composer (the plain tap)
  //   - "insert":  insert at the caret, replacing any selection (long-press)
  async function pasteFromClipboard(mode: "replace" | "insert") {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      taRef?.focus(); // permission denied / unsupported — leave the field focused so ⌘V works
      return;
    }
    if (!text) {
      taRef?.focus();
      return;
    }
    let pos: number;
    if (mode === "replace") {
      setInput(text);
      pos = text.length;
    } else {
      const cur = input();
      const start = taRef?.selectionStart ?? cur.length;
      const end = taRef?.selectionEnd ?? cur.length;
      const before = cur.slice(0, start);
      setInput(before + text + cur.slice(end));
      pos = before.length + text.length;
    }
    histIdx = -1;
    queueMicrotask(() => {
      if (taRef) {
        taRef.focus();
        taRef.selectionStart = taRef.selectionEnd = pos;
        setCaret(pos);
      }
    });
  }

  // Tap vs hold on the paste button: a plain tap replaces the whole composer; a
  // long-press inserts at the caret. The hold fires from a timer (still inside
  // the Clipboard API's transient-activation window) and suppresses the click
  // that follows the release.
  let pasteHoldTimer: number | undefined;
  let pasteDidHold = false;
  const onPasteDown = () => {
    pasteDidHold = false;
    clearTimeout(pasteHoldTimer);
    pasteHoldTimer = window.setTimeout(() => {
      pasteDidHold = true;
      void pasteFromClipboard("insert");
    }, 450);
  };
  const onPasteUp = () => clearTimeout(pasteHoldTimer);
  const onPasteClick = () => {
    clearTimeout(pasteHoldTimer);
    if (pasteDidHold) {
      pasteDidHold = false;
      return; // the long-press already inserted
    }
    void pasteFromClipboard("replace");
  };

  // The popup is portaled to <body> (fixed, above the composer) so chat content
  // can't paint over it. Anchored to the composer's rect; recomputed as items
  // change (which happens as you type, when the composer may have grown).
  let composerEl: HTMLDivElement | undefined;
  const acStyle = (): Record<string, string> => {
    acItems(); // recompute when the list changes
    if (!composerEl) return {};
    const r = composerEl.getBoundingClientRect();
    return {
      position: "fixed",
      left: `${Math.round(r.left)}px`,
      width: `${Math.round(r.width)}px`,
      bottom: `${Math.round(window.innerHeight - r.top + 6)}px`,
    };
  };
  const MAX_COMPOSER_PX = 200;
  function autosize() {
    const ta = taRef;
    if (!ta) return;
    if (focusMode()) {
      ta.style.height = "100%";
    } else {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, MAX_COMPOSER_PX) + "px";
    }
    if (mirrorRef) mirrorRef.scrollTop = ta.scrollTop;
  }
  // Re-measure after any value change (typing, draft restore, send-clear).
  createEffect(() => {
    input();
    focusMode();
    queueMicrotask(autosize);
  });

  // Reset to bottom + restore this session's saved draft when switching sessions.
  createEffect(
    on(
      () => props.sessionId,
      () => {
        setFollowing(true);
        setInput(loadVersioned<string>(draftKey(props.sessionId || "__new__"), 1, "", (o) => (typeof o === "string" ? o : "")));
        requestAnimationFrame(pin);
      },
    ),
  );
  // Persist the draft per session as it changes.
  createEffect(() => {
    const v = input();
    const sid = props.sessionId || "__new__";
    if (v) saveVersioned(draftKey(sid), 1, v);
    else localStorage.removeItem(draftKey(sid));
  });

  // In draft mode, materialize the server session on first send; otherwise use
  // the current session id.
  async function ensureSession(): Promise<string | null> {
    if (props.draft) return await createSession();
    return props.sessionId;
  }

  // Upload a file into the project's .vh-solara attachments dir and queue it
  // as a file part for the next message. Drafts get a real session first so the
  // attachment lands under sessions/<id>/.
  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const id = await ensureSession();
    if (!id) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/vh/attach?session=${encodeURIComponent(id)}`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) continue;
        const part = await res.json();
        if (part?.url) setAttachments((a) => [...a, { url: part.url, filename: part.filename, mime: part.mime }]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef) fileInputRef.value = "";
    }
  }
  const removeAttachment = (url: string) => setAttachments((a) => a.filter((x) => x.url !== url));

  function buildParts(text: string, atts: Attachment[]): any[] {
    const parts: any[] = [];
    if (text) parts.push({ type: "text", text });
    for (const a of atts) parts.push({ type: "file", url: a.url, filename: a.filename, mime: a.mime });
    return parts;
  }

  // The model/agent/variant to send with — the per-session selection, captured
  // so a queued message keeps the config it was composed with.
  function captureConfig(id: string): QueueConfig {
    const s = selectionFor(id);
    return { providerID: s?.providerID, modelID: s?.modelID, variant: s?.variant, agent: activeAgent() || undefined };
  }

  // Build + POST a prompt with explicit parts and send config (shared by direct
  // sends and queued auto-sends). prompt_async forks the turn and returns 204 at
  // once, so a send can never hang — the reply/failure arrive via the event feed.
  function sendParts(key: string, id: string, parts: any[], config: QueueConfig): Promise<boolean> {
    const body: any = { parts };
    if (config.agent) body.agent = config.agent; // only a live, enabled agent
    if (config.providerID && config.modelID) {
      body.model = { providerID: config.providerID, modelID: config.modelID };
      if (config.variant) body.variant = config.variant; // PromptInput.variant is top-level
    }
    jumpToLatest();
    return dispatchSend(key, id, `/oc/session/${encodeURIComponent(id)}/prompt_async`, body, "Message failed to send");
  }

  async function sendText(text: string, id: string): Promise<boolean> {
    const key = props.sessionId || "draft"; // guard keyed to this view, not the turn
    const atts = attachments();
    if ((!text && atts.length === 0) || !id || isSending(key)) return false;
    setSending(key, true);
    const parts = buildParts(text, atts);
    // Always send a model. OpenCode rejects a prompt with no model (brand-new
    // sessions with no model history). If models haven't loaded, fetch once.
    if (!selectionFor(id) && models().length === 0) await loadModels();
    const s = selectionFor(id);
    const config: QueueConfig = {
      providerID: s?.providerID || models()[0]?.providerID,
      modelID: s?.modelID || models()[0]?.modelID,
      variant: s?.variant,
      agent: activeAgent() || undefined,
    };
    setAttachments([]);
    return sendParts(key, id, parts, config);
  }

  // Auto-drain the queue: when the session is idle and has queued messages, send
  // the next one (FIFO, one per turn — the send makes it busy again, and the
  // next idle drains the following). Guarded so concurrent effect runs can't
  // double-send.
  let draining = false;
  async function drainQueue() {
    const id = props.sessionId;
    if (props.draft || !id || draining || isSending(id) || working()) return;
    const next = dequeue(id);
    if (!next) return;
    draining = true;
    try {
      setSending(id, true);
      const config = next.sendConfig?.providerID && next.sendConfig?.modelID ? (next.sendConfig as QueueConfig) : captureConfig(id);
      await sendParts(id, id, buildParts(next.text, next.attachments), config);
    } finally {
      draining = false;
    }
  }
  // Fires on busy→idle (turn finished) and on opening an idle session that still
  // has a queue (its turn finished while elsewhere). Reads queue length + working
  // reactively; the guards above keep it single-flight.
  createEffect(() => {
    void props.sessionId;
    const idle = !working();
    const pending = !props.draft && props.sessionId ? queueFor(props.sessionId).length : 0;
    if (idle && pending > 0) queueMicrotask(() => void drainQueue());
  });

  // POST a prompt/shell command and decide success WITHOUT waiting out the whole
  // turn. prompt_async returns 204 at once; /shell still buffers until the turn
  // *settles* — fast for a rejection (4xx/5xx arrive immediately) but possibly
  // minutes for a real turn, or never if it hangs. So: surface a fast failure
  // (caller restores the composer text), but once the request has clearly been
  // accepted, release the per-session guard and let the reply stream in via the
  // event feed — never freeze the composer on a long/hung turn. The fetch keeps
  // running in the background to clear the guard and
  // report any late error.
  function dispatchSend(
    key: string,
    id: string,
    url: string,
    body: any,
    failTitle: string,
  ): Promise<boolean> {
    const post = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          let detail = "";
          try {
            detail = (await res.text()).slice(0, 300);
          } catch {}
          log.error("send", "POST failed", { id, url, status: res.status, detail });
          pushNotification({ kind: "error", sessionID: id, title: failTitle, detail: detail || `HTTP ${res.status}` });
          return false;
        }
        log.debug("send", "accepted", { id, url });
        return true;
      })
      .catch((e) => {
        log.error("send", "POST threw", { id, url, err: String(e) });
        pushNotification({ kind: "error", sessionID: id, title: failTitle, detail: String(e) });
        return false;
      })
      .finally(() => setSending(key, false));

    // Race the request against a short grace period. A fast settle (error, or a
    // quick turn) resolves first and we honor it; otherwise the turn is running
    // — treat it as accepted, free the composer, and let `post` finish later.
    const ACCEPTED_AFTER_MS = 2500;
    return Promise.race([
      post,
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          setSending(key, false);
          resolve(true);
        }, ACCEPTED_AFTER_MS),
      ),
    ]);
  }

  // Leading "!" runs a shell command in the session instead of prompting.
  async function runShell(command: string, id: string): Promise<boolean> {
    const key = props.sessionId || "draft";
    if (!command || !id || isSending(key)) return false;
    setSending(key, true);
    const body: any = { command };
    const ag = activeAgent();
    if (ag) body.agent = ag; // never fall back to a hardcoded "build" that may be disabled
    const s = selectionFor(id);
    if (s) body.model = { providerID: s.providerID, modelID: s.modelID };
    jumpToLatest();
    return dispatchSend(key, id, `/oc/session/${encodeURIComponent(id)}/shell`, body, "Shell command failed");
  }

  async function send() {
    const text = input().trim();
    if (!text && attachments().length === 0) return;
    if (text) pushHistory(text); // recall with Up/Down later
    histIdx = -1;
    // Queue instead of sending while the session is busy — OpenCode rejects a
    // concurrent prompt, so we hold it and auto-send when the turn finishes.
    // (Shell/undo/redo aren't queueable — they only run against a live session.)
    if (queueMode() && !props.draft && props.sessionId && working() && !text.startsWith("!") && text !== "/undo" && text !== "/redo") {
      enqueue(props.sessionId, { text, attachments: attachments(), sendConfig: captureConfig(props.sessionId) });
      setInput("");
      setAttachments([]);
      return;
    }
    setInput("");
    // /undo /redo only make sense for an existing session.
    if (!props.draft && text === "/undo") return void undo();
    if (!props.draft && text === "/redo") return void redo();
    const id = await ensureSession();
    if (!id) {
      setInput(text); // session creation failed; keep the text for retry
      return;
    }
    // On failure, restore the composer text so a silent noop never loses what
    // the user typed (they can edit/retry instead of re-typing).
    const ok = text.startsWith("!")
      ? await runShell(text.slice(1).trim(), id)
      : await sendText(text, id);
    if (!ok) setInput(text);
  }

  // Concatenate a message's text/reasoning parts (the copyable/retryable text).
  function msgText(m: { partOrder: string[]; parts: Record<string, any> }) {
    return m.partOrder
      .map((pid) => m.parts[pid])
      .filter((p) => p && (p.type === "text" || p.type === "reasoning"))
      .map((p) => p.text || "")
      .join("\n")
      .trim();
  }
  const copyMessage = (m: any) => void navigator.clipboard?.writeText(msgText(m));
  const retry = (m: any) => void sendText(msgText(m), props.sessionId);

  // Inspect: tokens / cost / raw message JSON.
  const [inspectId, setInspectId] = createSignal<string | null>(null);
  const toggleInspect = (id: string) => setInspectId(inspectId() === id ? null : id);
  function inspectText(m: any): string {
    const i = m.info || {};
    const summary: any = {
      role: i.role,
      model: i.model ?? (i.providerID ? { providerID: i.providerID, modelID: i.modelID } : undefined),
      agent: i.agent,
      cost: i.cost,
      tokens: i.tokens,
      time: i.time,
    };
    return JSON.stringify({ summary, parts: m.partOrder.map((pid: string) => m.parts[pid]) }, null, 2);
  }

  // One-click fork from a turn.
  async function fork(messageID: string) {
    const res = await fetch(`/oc/session/${encodeURIComponent(props.sessionId)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID }),
    });
    const s = await res.json().catch(() => null);
    if (s?.id) {
      setSelectedId(s.id);
      void openSession(s.id);
    }
  }

  // /undo and /redo map to revert / unrevert of the latest turn.
  async function undo() {
    const sm = state.messages[props.sessionId];
    const lastId = sm?.order[sm.order.length - 1];
    if (!lastId) return;
    await fetch(`/oc/session/${encodeURIComponent(props.sessionId)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID: lastId }),
    });
  }
  async function redo() {
    await fetch(`/oc/session/${encodeURIComponent(props.sessionId)}/unrevert`, { method: "POST" });
  }

  async function abort() {
    // Clear the working indicator immediately — OpenCode doesn't reliably emit
    // an idle event on abort, so without this the spinner/shimmer would linger.
    markSessionIdle(props.sessionId);
    await fetch(`/oc/session/${encodeURIComponent(props.sessionId)}/abort`, { method: "POST" });
  }

  function onKeyDown(e: KeyboardEvent) {
    const ta = taRef;
    // Autocomplete owns the keys while its popup is open.
    if (acOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAcIndex((i) => Math.min(i + 1, acItems().length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAcIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyAc(acItems()[acIndex()]); return; }
      if (e.key === "Escape") { e.preventDefault(); setAcItems([]); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }
    // Shell-style history recall: Up when the caret is at the very start (so
    // multi-line editing isn't hijacked); Down steps back toward the live draft.
    if (e.key === "ArrowUp" && ta && ta.selectionStart === 0 && ta.selectionEnd === 0 && historyLen() > 0) {
      const next = Math.min(histIdx + 1, historyLen() - 1);
      const v = historyAt(next);
      if (v !== undefined) {
        e.preventDefault();
        if (histIdx === -1) histDraft = input();
        histIdx = next;
        setInput(v);
        queueMicrotask(() => ta && (ta.selectionStart = ta.selectionEnd = 0));
      }
    } else if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      histIdx -= 1;
      setInput(histIdx < 0 ? histDraft : historyAt(histIdx) ?? "");
    }
  }

  return (
    <div class="chat" classList={{ draft: props.draft }}>
      <Show when={props.draft}>
        <div class="chat-hero">
          <BrandMark class="chat-hero-mark" />
          <h2 class="chat-hero-title">Start a new session</h2>
          <p class="chat-hero-sub">
            Type your first message below — the session is created when you send.
          </p>
        </div>
      </Show>
      <Show when={!props.draft}>
      <div class="chat-scroll" ref={scrollEl} onScroll={onScrolled}>
        <div class="chat-content" ref={contentEl} classList={{ ready: ready() }}>
          <For each={messages()}>
            {(m, i) => (
              <div class="msg" classList={{ user: m.info.role === "user", assistant: m.info.role === "assistant" }}>
                <div class="msg-head">
                  <span class="msg-role">{roleLabel(m.info.role)}</span>
                  <Show when={modelLabel(m.info)}>
                    <span class="msg-model" data-tip={modelLabel(m.info)}>{modelLabel(m.info)}</span>
                  </Show>
                  <RelTime class="msg-time" mode="ago" ms={m.info.time?.created} />
                  <Show when={costLabel(m.info)}>
                    <span class="msg-cost">{costLabel(m.info)}</span>
                  </Show>
                  <div class="msg-actions">
                    <button type="button" data-tip="Copy" aria-label="Copy" onClick={() => copyMessage(m)}>
                      <Icon name="copy" size={14} />
                    </button>
                    <button type="button" data-tip="Inspect" aria-label="Inspect" onClick={() => toggleInspect(m.id)}>
                      <Icon name="info" size={14} />
                    </button>
                    <button type="button" data-tip="Fork from here" aria-label="Fork" onClick={() => fork(m.id)}>
                      <Icon name="fork" size={14} />
                    </button>
                    <Show when={m.info.role === "user"}>
                      <button type="button" data-tip="Retry" aria-label="Retry" onClick={() => retry(m)}>
                        <Icon name="retry" size={14} />
                      </button>
                    </Show>
                  </div>
                </div>
                <Deferred
                  class="msg-parts"
                  eager={i() >= messages().length - EAGER_TAIL}
                  root={() => scrollEl}
                  minHeight={48}
                >
                  <MessageParts
                    m={m}
                    isLastMessage={() => i() === messages().length - 1}
                    lastActivityKey={lastActivityKey}
                  />
                </Deferred>
                <Show when={messageError(m.info)}>
                  <div class="msg-error">⚠ {messageError(m.info)}</div>
                </Show>
                <Show when={inspectId() === m.id}>
                  <pre class="msg-inspect">{inspectText(m)}</pre>
                </Show>
              </div>
            )}
          </For>
          <Show when={working()}>
            <div class="working" aria-label="Assistant is working">
              <span class="working-shimmer">Working…</span>
            </div>
          </Show>
        </div>
      </div>
      </Show>

      <Show when={!following()}>
        <button type="button" class="jump" onClick={jumpToLatest}>
          <Icon name="arrowDown" size={14} /> Latest
        </button>
      </Show>

      <Show when={pendingQuestions().length > 0}>
        <div class="perms">
          <For each={pendingQuestions()}>{(q) => <QuestionCard question={q as any} />}</For>
        </div>
      </Show>

      <Show when={pendingPermissions().length > 0}>
        <div class="perms">
          <For each={pendingPermissions()}>
            {(p) => (
              <div class="perm-card">
                <div class="perm-title">
                  🔒 Permission requested<Show when={permLabel(p)}>: <strong>{permLabel(p)}</strong></Show>
                </div>
                <Show when={permDetail(p)}>
                  <pre class="perm-detail">{permDetail(p)}</pre>
                </Show>
                <div class="perm-actions">
                  <button type="button" onClick={() => respondPermission(props.sessionId, p.id, "once")}>
                    Allow once
                  </button>
                  <button type="button" onClick={() => respondPermission(props.sessionId, p.id, "always")}>
                    Always
                  </button>
                  <button type="button" class="reject" onClick={() => respondPermission(props.sessionId, p.id, "reject")}>
                    Reject
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={todoCounts().left > 0}>
        <div class="tasks-bar" classList={{ open: todosOpen() }} ref={tasksBarEl}>
          <button type="button" class="tasks-pill" onClick={() => setTodosOpen((v) => !v)} aria-expanded={todosOpen()}>
            <span class="tasks-label">Tasks</span>
            <span class="tasks-count">{todoCounts().active} active</span>
            <span class="tasks-sep">·</span>
            <span class="tasks-count">{todoCounts().left} left</span>
            <span class="tasks-chev" classList={{ rot: todosOpen() }}><Icon name="chevronDown" size={12} /></span>
          </button>
          <Show when={todosOpen()}>
            <ul class="tasks-list">
              <For each={todoItems()}>
                {(t) => (
                  <li class="tasks-item" classList={{ done: t.status === "completed", active: t.status === "in_progress", cancelled: t.status === "cancelled" }}>
                    <span class="tasks-item-dot" />
                    <span class="tasks-item-text">{t.content || "(untitled)"}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>

      <div class="composer-wrap">
        <Show
          when={!isChild()}
          fallback={
            <div class="composer-child-note">
              <span>Prompting is disabled for subagent sessions.</span>
              <Show when={parentId()}>
                <button type="button" class="composer-child-back" onClick={openParent}>
                  Back to parent session →
                </button>
              </Show>
              {/* A stuck subagent can still be stopped from here. */}
              <Show when={working()}>
                <button type="button" class="composer-child-stop" onClick={abort}>
                  <Icon name="stop" size={13} /> Stop
                </button>
              </Show>
            </div>
          }
        >
        <div class="composer" classList={{ focus: focusMode() }} ref={composerEl}>
          {/* Autocomplete popup (@file / @agent / /command). Portaled to body so
              chat content can't paint over it; positioned above the composer. */}
          <Show when={acOpen()}>
            <Portal>
              <div class="ac-pop" style={acStyle()}>
                <For each={acItems()}>
                  {(it, i) => (
                    <button
                      type="button"
                      class="ac-item"
                      classList={{ active: i() === acIndex() }}
                      onMouseDown={(e) => { e.preventDefault(); applyAc(it); }}
                      onMouseEnter={() => setAcIndex(i())}
                    >
                      <span class="ac-kind" classList={{ [it.kind]: true }}>{it.kind === "command" ? "/" : it.kind === "agent" ? "@" : "⎘"}</span>
                      <span class="ac-label">{it.label}</span>
                      <Show when={it.detail}><span class="ac-detail">{it.detail}</span></Show>
                    </button>
                  )}
                </For>
              </div>
            </Portal>
          </Show>
          {/* Queued messages waiting for the running turn to finish. */}
          <Show when={!props.draft && queueFor(props.sessionId).length > 0}>
            <div class="queue-row">
              <span class="queue-label" data-tip="Sent automatically when the current turn finishes">
                Queued
              </span>
              <For each={queueFor(props.sessionId)}>
                {(q) => (
                  <span class="queue-chip" data-tip={q.text}>
                    <span class="queue-text">{q.text || "(attachment)"}</span>
                    <button type="button" aria-label="Remove queued message" onClick={() => removeQueued(props.sessionId, q.id)}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={attachments().length > 0 || uploading()}>
            <div class="attach-row">
              <For each={attachments()}>
                {(a) => (
                  <span class="attach-chip" data-tip={a.filename}>
                    <Icon name="paperclip" size={12} />
                    <span class="attach-name">{a.filename}</span>
                    <button type="button" aria-label="Remove attachment" onClick={() => removeAttachment(a.url)}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                )}
              </For>
              <Show when={uploading()}>
                <span class="attach-chip uploading">Uploading…</span>
              </Show>
            </div>
          </Show>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => void addFiles(e.currentTarget.files)}
          />
          <div
            class="composer-field"
            classList={{ shell: input().startsWith("!"), command: input().startsWith("/") }}
          >
            <div ref={mirrorRef} class="composer-mirror" aria-hidden="true" innerHTML={highlightInput(input())} />
            <textarea
              ref={taRef}
              class="composer-text"
              value={input()}
              onInput={(e) => (setInput(e.currentTarget.value), setCaret(e.currentTarget.selectionStart ?? 0), (histIdx = -1))}
              onClick={syncCaret}
              onKeyUp={syncCaret}
              onBlur={() => setTimeout(() => setAcItems([]), 150)}
              onScroll={(e) => mirrorRef && (mirrorRef.scrollTop = e.currentTarget.scrollTop)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                // Paste an image/file (e.g. a screenshot) straight into the
                // composer as an attachment; plain-text paste falls through.
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              placeholder={"Message…   (! = shell, /undo /redo)"}
              rows={1}
            />
          </div>
          <div class="composer-bar">
            <Show when={agents().length > 0}>
              <Select
                class="bar-select agent-select"
                ariaLabel="Agent"
                value={selectedAgent() ?? ""}
                options={agents().map((a) => ({ value: a.name, label: `@${a.name}` }))}
                onChange={(v) => selectAgentForSession(props.sessionId, v)}
              />
            </Show>
            <Show when={models().length > 0}>
              <button type="button" class="bar-btn model-btn" aria-label="Model" onClick={() => setModelDialog(true)}>
                <span class="model-btn-name">{curModel()?.name || "Select model"}</span>
                <span class="model-btn-caret"><Icon name="chevronDown" size={14} /></span>
              </button>
              <Show when={(curModel()?.variants?.length ?? 0) > 0}>
                <Select
                  class="bar-select variant-select"
                  ariaLabel="Variant"
                  value={curVariant()}
                  options={[
                    { value: "", label: "default" },
                    ...curModel()!.variants.map((v) => ({ value: v, label: v })),
                  ]}
                  onChange={(v) => chooseVariant(props.sessionId, v || undefined)}
                />
              </Show>
            </Show>
            <span class="bar-spacer" />
            <button
              type="button"
              class="bar-icon"
              aria-label="Paste (hold to insert at cursor)"
              data-tip="Paste — replaces all · hold to insert at cursor"
              onClick={onPasteClick}
              onPointerDown={onPasteDown}
              onPointerUp={onPasteUp}
              onPointerLeave={onPasteUp}
              onPointerCancel={onPasteUp}
            >
              <Icon name="clipboard" />
            </button>
            <button
              type="button"
              class="bar-icon"
              aria-label="Attach file"
              data-tip="Attach file"
              disabled={uploading()}
              onClick={() => fileInputRef?.click()}
            >
              <Icon name="paperclip" />
            </button>
            <button
              type="button"
              class="bar-icon"
              aria-label="Focus mode"
              data-tip="Expand / focus"
              onClick={() => setFocusMode((v) => !v)}
            >
              <Icon name="maximize" />
            </button>
            <Show
              when={working()}
              fallback={
                <button type="button" class="send-btn" aria-label="Send" onClick={send} disabled={sending()}>
                  <Icon name="send" />
                </button>
              }
            >
              {/* Busy: Stop aborts the running turn; a Queue button appears once
                  you've typed something (Enter queues too). */}
              <Show when={queueMode() && input().trim().length > 0}>
                <button type="button" class="send-btn queue" aria-label="Queue" data-tip="Queue — sends when the current turn finishes" onClick={send}>
                  <Icon name="plus" />
                </button>
              </Show>
              <button type="button" class="send-btn stop" aria-label="Stop" onClick={abort}>
                <Icon name="stop" />
              </button>
            </Show>
          </div>
          <Show when={modelDialog()}>
            <ModelDialog sessionId={props.sessionId} onClose={() => setModelDialog(false)} />
          </Show>
        </div>
        </Show>
      </div>
    </div>
  );
}
