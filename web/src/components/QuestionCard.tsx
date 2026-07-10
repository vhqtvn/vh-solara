import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { Question } from "../types";
import { respondQuestion } from "../sync";
import { renderMarkdown } from "../render";
import Icon from "./Icon";
import { useCardPopup } from "./cardPopup";
import { usePendingInputHold } from "./PendingInput";
import styles from "./QuestionCard.module.css";

// Goldmark wraps a lone paragraph as <p>…</p>. Inside a <button> that is
// invalid phrasing content, so for INLINE contexts (option label/description)
// strip a single wrapping <p>. Multi-block content is returned unchanged.
function inlineMd(html: string): string {
  const m = /^<p>([\s\S]*?)<\/p>$/.exec(html.trim());
  return m ? m[1] : html;
}

// Markdown body via the SETTLED-CONTENT path (server-rendered, sanitized HTML
// from POST /vh/render) — NOT the streaming `Markdown` component used for live
// chat deltas.
//
//   `block`  → <div class="md …">  (question text; valid flow context)
//   inline   → <span class="md …"> (option label/desc, wrapping <p> stripped)
//
// The `innerHTML={safe()}` getter is reactive (SolidJS wraps attribute
// expressions in getters), so the body swaps in once the batched render
// resolves; before that the raw text is shown as a fallback.
function Md(props: { text: string; block?: boolean; class?: string }) {
  const [html] = createResource(() => props.text, (t) => renderMarkdown(t || ""));
  const cls = "md" + (props.class ? " " + props.class : "");
  const safe = () => {
    const h = html();
    if (!h) return "";
    return props.block ? h : inlineMd(h);
  };
  // SolidJS does not render a capitalized variable holding a native-tag string
  // (unlike React), so branch explicitly instead of using a dynamic tag.
  if (props.block) {
    return (
      <Show when={html()} fallback={<div class={cls + " md-raw"}>{props.text}</div>}>
        <div class={cls} innerHTML={safe()} />
      </Show>
    );
  }
  return (
    <Show when={html()} fallback={<span class={cls + " md-raw"}>{props.text}</span>}>
      <span class={cls} innerHTML={safe()} />
    </Show>
  );
}

export default function QuestionCard(props: { question: Question }) {
  const items = () => props.question.questions || [];

  // --- Shared state (signals owned by THIS component) ---------------------
  // The inline in-stream surface and the Portal-rendered popup surface both
  // read/write these SAME signals. An option picked or text typed in one is
  // instantly reflected in the other, and the draft/selection survives popup
  // open/close because the state lives in the component, not the DOM.
  const [picked, setPicked] = createSignal<Record<number, string[]>>({});
  const [custom, setCustom] = createSignal<Record<number, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [layout, setLayout] = createSignal<"v" | "h">("v");

  // Shared popup chrome (open/close + focus capture/restore + ESC + Tab trap).
  // The card's signals and `body()` stay here; only the popup lifecycle is
  // delegated. See components/cardPopup.ts.
  const popup = useCardPopup();

  // Report popup-open up to the PendingInput host so it can keep the
  // interaction-scoped follow hold active while the operator is in the
  // portaled popup (focus leaves the wrapper subtree into the portal, so
  // focus-within alone would release a hold mid-interaction). No-op when the
  // card is rendered without a PendingInput ancestor (standalone tests).
  const hold = usePendingInputHold();
  createEffect(() => hold?.setPopupOpen(popup.open()));

  function toggle(qi: number, label: string, multiple?: boolean) {
    setPicked((prev) => {
      const cur = prev[qi] || [];
      let next: string[];
      if (!multiple) {
        next = cur.includes(label) ? [] : [label];
      } else {
        next = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label];
      }
      return { ...prev, [qi]: next };
    });
  }
  const answerFor = (qi: number) => {
    const out = [...(picked()[qi] || [])];
    const c = (custom()[qi] || "").trim();
    if (c) out.push(c);
    return out;
  };
  const ready = () => items().every((_, qi) => answerFor(qi).length > 0);

  async function submit() {
    if (!ready() || busy()) return;
    setBusy(true);
    try {
      await respondQuestion(
        props.question.id,
        items().map((_, qi) => answerFor(qi)),
      );
    } finally {
      setBusy(false);
    }
  }

  const toggleLayout = () => setLayout((l) => (l === "v" ? "h" : "v"));
  // Shared H/V toggle button — used in BOTH the inline head and the popup head,
  // bound to the same `layout` signal so flipping it in one reflects in the
  // other.
  const toggleBtn = () => (
    <button
      type="button"
      class="card-icon-btn"
      onClick={toggleLayout}
      data-tip={layout() === "v" ? "Switch to horizontal options" : "Switch to vertical options"}
      aria-label="Toggle option layout"
    >
      <Icon name={layout() === "v" ? "rows" : "columns"} size={13} />
    </button>
  );

  // --- Shared body --------------------------------------------------------
  // ONE function returning JSX, used by BOTH surfaces. SolidJS fine-grained
  // reactivity means each call site binds independently to the SAME signals, so
  // the two rendered copies stay synchronized (selections, custom-answer
  // draft, layout, busy) without duplicating the component.
  const body = () => (
    <>
      <For each={items()}>
        {(q, qi) => (
          <div class={styles["question-item"]}>
            <Show when={q.header}>
              <div class={styles["question-label"]}>{q.header}</div>
            </Show>
            <Md block class={styles["question-text"]} text={q.question} />
            <Show when={q.options && q.options.length}>
              <div
                class="question-options"
                classList={{ h: layout() === "h", v: layout() === "v" }}
                role="group"
              >
                <For each={q.options}>
                  {(opt, oi) => (
                    <button
                      type="button"
                      class="question-opt"
                      classList={{ on: (picked()[qi()] || []).includes(opt.label) }}
                      onClick={() => toggle(qi(), opt.label, q.multiple)}
                    >
                      <span class="question-opt-key" aria-hidden="true">
                        {String.fromCharCode(65 + (oi() % 26))}:
                      </span>
                      <span class={styles["question-opt-body"]}>
                        <Md class="question-opt-label" text={opt.label} />
                        <Show when={opt.description}>
                          <Md class={styles["question-opt-desc"]} text={opt.description!} />
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            {/* The custom-answer textarea is ALWAYS full-width/vertical,
                independent of the H/V option toggle. */}
            <Show when={q.custom !== false}>
              <textarea
                class="question-custom"
                rows={2}
                placeholder="Type your own answer… (⌘/Ctrl+Enter to send)"
                value={custom()[qi()] || ""}
                onInput={(e) =>
                  setCustom((c) => ({ ...c, [qi()]: e.currentTarget.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </Show>
          </div>
        )}
      </For>
      <div class={styles["question-actions"]}>
        <button
          type="button"
          class="question-send"
          disabled={!ready() || busy()}
          onClick={() => void submit()}
        >
          <Icon name="check" size={14} /> Reply
        </button>
      </div>
    </>
  );

  return (
    <div class="question-card">
      {/* Inline head: title + H/V toggle + popup-open trigger. */}
      <div class={styles["question-head"]}>
        <span class={styles["question-head-title"]}>
          <Icon name="help" size={15} /> Answer needed
        </span>
        <span class="card-tools">
          {toggleBtn()}
          <button
            type="button"
            class="card-icon-btn"
            onClick={popup.show}
            data-tip="Open in popup"
            aria-label="Open answer in popup"
          >
            <Icon name="maximize" size={13} />
          </button>
        </span>
      </div>

      {/* Inline in-stream surface. */}
      {body()}

      {/* Popup surface — mirrors the card with SHARED STATE. Renders the same
          `body()` and the same toggle bound to the same signals. */}
      <Show when={popup.open()}>
        <Portal>
          <div class="card-pop-overlay" onClick={popup.hide}>
            <div
              ref={popup.setPopRef}
              class="card-pop card-pop-question"
              role="dialog"
              aria-modal="true"
              aria-label="Answer needed"
              tabindex="-1"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="card-pop-head">
                <span class="card-pop-title">
                  <Icon name="help" size={15} /> Answer needed
                </span>
                <span class="card-tools">
                  {toggleBtn()}
                  <button
                    type="button"
                    class="card-icon-btn"
                    onClick={popup.hide}
                    aria-label="Close popup"
                  >
                    <Icon name="x" size={14} />
                  </button>
                </span>
              </div>
              <div class="card-pop-body">{body()}</div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
