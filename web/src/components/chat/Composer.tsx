// Composer JSX shell — the composer area markup (autocomplete popover, queue
// chips, attachment chips, hidden file input, mirror+textarea, composer-bar),
// extracted from ChatView as a presentational component. It receives the
// controller factory objects + reactive accessors + ref callbacks as props; it
// owns NO state of its own except the composer element (used only by the
// acStyle popover positioning helper below) and a local mirror reference (for
// the textarea onScroll lockstep, which the original wrote directly).
//
// Behavior-preserving extraction: the DOM tree is IDENTICAL to the original
// inline JSX (no wrapper element — Composer renders <div class="composer-wrap">
// directly). Only variable references change: ChatView-local signals/memos
// become props.X() accessor calls; module-level imports (agents/models/queue/
// highlight/inlineAttach) are imported directly here.
//
// What STAYED in ChatView (NOT passed here): autosize + its rAF effect, the
// focus-mode re-glue effect (both scroll-coupled), and the taRef/mirrorRef
// ownership (autosize reads them). taRef is forwarded via a ref callback;
// mirrorRef is forwarded AND kept locally (the textarea onScroll writes to it).
// fileInputRef stays in ChatView (createAttachments reads it) — forwarded via a
// ref callback + an onPickFile click delegation.

import { type Accessor, type Setter, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { agents, agentForSession, selectAgentForSession } from "../../agents";
import { agentDisplay } from "../../projectSettings";
import { chooseVariant, models } from "../../models";
import { queueFor, queueMode, removeQueued } from "../../queue";
import { highlightInput } from "../../lib/composerHighlight";
import { isInlineChipOrphan } from "../../lib/inlineAttach";
import { layoutPx } from "../../lib/zoom";
import Icon from "../Icon";
import { QueueChip } from "../QueueChip";
import Select from "../Select";
import ModelDialog from "../ModelDialog";
import type { ComposerAutocomplete } from "./createComposerAutocomplete";
import type { Attachments } from "./createAttachments";
import type { ComposerPaste } from "./createComposerPaste";
import type { PromptHistory } from "./createPromptHistory";
import type { QueueRecovery } from "./createQueueRecovery";

export interface ComposerProps {
  // session context
  draft: Accessor<boolean>;
  sessionId: Accessor<string>;
  // child-session gating (subagent sessions disable prompting)
  isChild: Accessor<boolean>;
  parentId: Accessor<string | undefined>;
  onOpenParent: () => void;
  // reactive composer state (owned by ChatView; autosize/scroll need some)
  input: Accessor<string>;
  setInput: Setter<string>;
  focusMode: Accessor<boolean>;
  setFocusMode: Setter<boolean>;
  working: Accessor<boolean>;
  sending: Accessor<boolean>;
  sendInFlight: Accessor<boolean>;
  readyToSend: Accessor<boolean>;
  curModel: Accessor<{ name?: string; variants: string[] } | undefined>;
  curVariant: Accessor<string>;
  modelDialog: Accessor<boolean>;
  setModelDialog: Setter<boolean>;
  // controller factories (constructed in ChatView)
  ac: ComposerAutocomplete;
  att: Attachments;
  paste: ComposerPaste;
  hist: PromptHistory;
  recovery: QueueRecovery;
  // send / abort
  send: () => Promise<void>;
  abort: () => void;
  // refs owned by ChatView (autosize reads taRef/mirrorRef; createAttachments
  // reads fileInputRef). Forwarded as ref callbacks.
  refTa: (el: HTMLTextAreaElement) => void;
  refMirror: (el: HTMLDivElement) => void;
  refFileInput: (el: HTMLInputElement) => void;
  onPickFile: () => void;
}

export function Composer(props: ComposerProps) {
  // The popup is portaled to <body> (fixed, above the composer) so chat content
  // can't paint over it. Anchored to the composer's rect; recomputed as items
  // change (which happens as you type, when the composer may have grown).
  // composerEl is LOCAL to Composer: it is consumed ONLY by acStyle + this
  // component's ref binding (autosize/scroll never reference it — a deviation
  // from the extraction map, which grouped it with taRef/mirrorRef; verified by
  // grep: zero other readers in ChatView).
  let composerEl: HTMLDivElement | undefined;
  const acStyle = (): Record<string, string> => {
    props.ac.acItems(); // recompute when the list changes
    if (!composerEl) return {};
    const r = composerEl.getBoundingClientRect();
    // r (and window.innerHeight) are VIEWPORT px, but these inline lengths land
    // in the popup's own ZOOMED-LAYOUT space (CSS `zoom` on :root — see
    // lib/zoom.ts); convert each at this style boundary or the popup offsets by
    // the zoom factor. Identity at zoom = 1.
    return {
      position: "fixed",
      left: `${layoutPx(Math.round(r.left))}px`,
      width: `${layoutPx(Math.round(r.width))}px`,
      bottom: `${layoutPx(Math.round(window.innerHeight - r.top + 6))}px`,
    };
  };
  // Local copy of the mirror element for the textarea onScroll lockstep write
  // (the original wrote `mirrorRef.scrollTop = ...` directly). The ref is ALSO
  // forwarded to ChatView via props.refMirror so autosize can read it.
  let mirrorEl: HTMLDivElement | undefined;

  // Shared key dispatcher for the composer: autocomplete FIRST (owns its keys
  // while the popover is open), then send (Enter), then prompt-history LAST.
  // ac.onAcKeyDown returns true when it consumed the key; otherwise it falls
  // through here. hist.onHistoryKey returns true when it recalled/stepped (and
  // calls preventDefault itself); the return is informational — history is the
  // LAST entry, so there is nothing further to fall through to. This preserves
  // the autocomplete → send → history precedence (C3 → C5 shared dispatcher).
  function onKeyDown(e: KeyboardEvent) {
    if (props.ac.onAcKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void props.send();
      return;
    }
    props.hist.onHistoryKey(e);
  }

  return (
    <div class="composer-wrap">
        <Show
          when={!props.isChild()}
          fallback={
            <div class="composer-child-note">
              <span>Prompting is disabled for subagent sessions.</span>
              <Show when={props.parentId()}>
                <button type="button" class="composer-child-back" onClick={props.onOpenParent}>
                  Back to parent session →
                </button>
              </Show>
              {/* A stuck subagent can still be stopped from here. */}
              <Show when={props.working()}>
                <button type="button" class="composer-child-stop" onClick={props.abort}>
                  <Icon name="stop" size={13} /> Stop
                </button>
              </Show>
            </div>
          }
        >
        <div class="composer" classList={{ focus: props.focusMode() }} ref={composerEl}>
          {/* Autocomplete popup (@file / @agent / /command). Portaled to body so
              chat content can't paint over it; positioned above the composer. */}
          <Show when={props.ac.acVisible()}>
            <Portal>
              <div class="ac-pop" style={acStyle()}>
                <For each={props.ac.acItems()}>
                  {(it, i) => (
                    <button
                      type="button"
                      class="ac-item"
                      classList={{ active: i() === props.ac.acIndex() }}
                      onMouseDown={(e) => { e.preventDefault(); props.ac.applyAc(it); }}
                      onMouseEnter={() => props.ac.setAcIndex(i())}
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
          {/* Queue chips reflect the backend-authoritative per-session queue.
              pending → removable (cancel before dispatch); dispatching → in
              flight, NOT removable (the state machine owns the transition to
              terminal); terminal `failed`/`unknown` → dismissable
              (FIX-QUEUE-GC-4 flipped DELETE from pending-only to "pending +
              terminal; not dispatching") AND recoverable (retract-to-compose for
              failed/unknown, mark-sent for unknown — Bug 1 / Bug 2). `sent` is
              filtered from the visible queue upstream (queueFor), so it needs no
              surface. See QueueChip.tsx for the per-state action wiring. */}
          <Show when={!props.draft() && queueFor(props.sessionId()).length > 0}>
            <div class="queue-row">
              <span class="queue-label" data-tip="Sent automatically when the current turn finishes">
                Queued
              </span>
              <For each={queueFor(props.sessionId())}>
                {(q) => (
                  <QueueChip
                    q={q}
                    onRemove={(id) => void removeQueued(props.sessionId(), id)}
                    onRetract={props.recovery.retract}
                    onMarkSent={props.recovery.markSent}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={props.att.attachments().length > 0 || props.att.uploading()}>
            <div class="attach-row">
              <For each={props.att.attachments()}>
                {(a) => {
                  // S5: an inline chip (vh-attach:<localId>) is an ORPHAN when
                  // its token is absent from the composer text (the user deleted
                  // the markdown ref). Its held File will NOT be uploaded at
                  // send (lazy upload skips absent tokens); show it dimmed with
                  // a "won't be sent" badge + a re-insert control that splices
                  // the ref back at the caret. Non-inline chips (real file://
                  // uploads) are never orphans. presentInlineIds is a memo over
                  // scanInlineTokens(input()) so this re-evaluates on every
                  // keystroke.
                  //
                  // a-F1: orphan is a DERIVED ACCESSOR, not a captured boolean.
                  // SolidJS <For> callbacks run ONCE per item in a NON-tracking
                  // scope, so a captured `const orphan = isInlineChipOrphan(...)`
                  // would freeze at item-creation and never react to
                  // presentInlineIds() changes — the dim/badge/re-insert button
                  // would NOT appear/disappear as the user edits the composer
                  // text, defeating S5. Reading orphan() inside JSX props/class
                  // /Show lets the Solid compiler wrap each read in a reactive
                  // effect so the orphan UI tracks the live present-token set.
                  const orphan = () => isInlineChipOrphan(a.url, props.att.presentInlineIds());
                  return (
                    <span
                      class="attach-chip"
                      classList={{ orphan: orphan() }}
                      data-tip={orphan() ? `${a.filename} (ref removed — won't be sent)` : a.filename}
                    >
                      <Icon name="paperclip" size={12} />
                      <span class="attach-name">{a.filename}</span>
                      <Show when={orphan()}>
                        <span
                          class="attach-orphan-badge"
                          title="Reference removed from message — won't be uploaded or sent. Re-insert to restore."
                        >
                          ref removed
                        </span>
                        <button
                          type="button"
                          aria-label={`Re-insert ${a.filename} into message`}
                          title="Re-insert into message"
                          onClick={() => props.att.reinsertInlineChip(a)}
                        >
                          <Icon name="retry" size={11} />
                        </button>
                      </Show>
                      <button type="button" aria-label="Remove attachment" onClick={() => props.att.removeAttachment(a.url)}>
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  );
                }}
              </For>
              <Show when={props.att.uploading()}>
                <span class="attach-chip uploading">Uploading…</span>
              </Show>
            </div>
          </Show>
          <input
            ref={props.refFileInput}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => void props.att.addFiles(e.currentTarget.files)}
          />
          <div
            class="composer-field"
            classList={{ shell: props.input().startsWith("!"), command: props.input().startsWith("/") }}
          >
            <div ref={(el: HTMLDivElement) => { mirrorEl = el; props.refMirror(el); }} class="composer-mirror" aria-hidden="true" innerHTML={highlightInput(props.input())} />
            <textarea
              ref={props.refTa}
              class="composer-text"
              value={props.input()}
              onInput={(e) => (props.setInput(e.currentTarget.value), props.ac.syncCaret(), props.hist.resetHistory())}
              onClick={props.ac.syncCaret}
              onKeyUp={props.ac.syncCaret}
              onBlur={() => setTimeout(() => props.ac.dismissAc(), 150)}
              onScroll={(e) => mirrorEl && (mirrorEl.scrollTop = e.currentTarget.scrollTop)}
              onKeyDown={onKeyDown}
              onPaste={props.paste.onPaste}
              placeholder={"Message…   (! = shell, /undo /redo)"}
              rows={1}
            />
          </div>
          <div class="composer-bar">
            <Show when={agents().length > 0} fallback={<span class="bar-loading">Loading agents…</span>}>
              <Select
                class="bar-select agent-select"
                ariaLabel="Agent"
                value={agentForSession(props.sessionId())}
                options={agents().map((a) => ({ value: a.name, label: `@${a.name}`, swatch: agentDisplay(a.name)?.color, sub: a.description }))}
                onChange={(v) => selectAgentForSession(props.sessionId(), v)}
              />
            </Show>
            <Show when={models().length > 0}>
              <button type="button" class="bar-btn model-btn" aria-label="Model" onClick={() => props.setModelDialog(true)}>
                <span class="model-btn-name">{props.curModel()?.name || "Select model"}</span>
                <span class="model-btn-caret"><Icon name="chevronDown" size={14} /></span>
              </button>
              <Show when={(props.curModel()?.variants?.length ?? 0) > 0}>
                <Select
                  class="bar-select variant-select"
                  ariaLabel="Variant"
                  value={props.curVariant()}
                  options={[
                    { value: "", label: "default" },
                    ...props.curModel()!.variants.map((v) => ({ value: v, label: v })),
                  ]}
                  onChange={(v) => chooseVariant(props.sessionId(), v || undefined)}
                />
              </Show>
            </Show>
            <span class="bar-spacer" />
            <button
              type="button"
              class="bar-icon"
              aria-label="Paste (hold to insert at cursor)"
              data-tip="Paste — replaces all · hold to insert at cursor"
              onClick={props.paste.onPasteButtonClick}
              onPointerDown={props.paste.onPasteButtonDown}
              onPointerUp={props.paste.onPasteButtonUp}
              onPointerLeave={props.paste.onPasteButtonUp}
              onPointerCancel={props.paste.onPasteButtonUp}
              onBlur={props.paste.onPasteButtonBlur}
            >
              <Icon name="clipboard" />
            </button>
            <button
              type="button"
              class="bar-icon"
              aria-label="Attach file"
              data-tip="Attach file"
              disabled={props.att.uploading()}
              onClick={props.onPickFile}
            >
              <Icon name="paperclip" />
            </button>
            <button
              type="button"
              class="bar-icon"
              aria-label="Focus mode"
              data-tip="Expand / focus"
              onClick={() => props.setFocusMode((v) => !v)}
            >
              <Icon name="maximize" />
            </button>
            <Show
              when={props.working()}
              fallback={
                <button
                  type="button"
                  class="send-btn"
                  classList={{ sending: props.sendInFlight() }}
                  aria-label={props.sendInFlight() ? "Sending…" : "Send"}
                  onClick={props.send}
                  disabled={props.sending() || props.sendInFlight() || !props.readyToSend()}
                >
                  <Icon name="send" />
                </button>
              }
            >
              {/* Busy: Stop aborts the running turn; a Queue button appears once
                  you've typed something (Enter queues too). */}
              <Show when={queueMode() && props.input().trim().length > 0}>
                <button
                  type="button"
                  class="send-btn queue"
                  classList={{ sending: props.sendInFlight() }}
                  aria-label={props.sendInFlight() ? "Queueing…" : "Queue"}
                  data-tip="Queue — sends when the current turn finishes"
                  disabled={props.sendInFlight() || !props.readyToSend()}
                  onClick={props.send}
                >
                  <Icon name="plus" />
                </button>
              </Show>
              <button type="button" class="send-btn stop" aria-label="Stop" onClick={props.abort}>
                <Icon name="stop" />
              </button>
            </Show>
          </div>
          <Show when={props.modelDialog()}>
            <ModelDialog sessionId={props.sessionId()} onClose={() => props.setModelDialog(false)} />
          </Show>
        </div>
        </Show>
      </div>
  );
}
