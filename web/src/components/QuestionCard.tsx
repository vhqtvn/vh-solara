import { createSignal, For, Show } from "solid-js";
import type { Question } from "../types";
import { respondQuestion } from "../sync";
import Icon from "./Icon";

// Renders one pending question request (which may carry several questions) and
// collects an answer per question — single- or multi-select plus an optional
// free-text custom answer — then replies once all are answered.
export default function QuestionCard(props: { question: Question }) {
  const items = () => props.question.questions || [];
  // Per-question selected labels and custom text.
  const [picked, setPicked] = createSignal<Record<number, string[]>>({});
  const [custom, setCustom] = createSignal<Record<number, string>>({});
  const [busy, setBusy] = createSignal(false);

  function toggle(qi: number, label: string, multiple?: boolean) {
    setPicked((p) => {
      const cur = p[qi] || [];
      let next: string[];
      if (multiple) {
        next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      } else {
        next = cur.includes(label) ? [] : [label];
      }
      return { ...p, [qi]: next };
    });
  }

  const answerFor = (qi: number) => {
    const chosen = [...(picked()[qi] || [])];
    const c = (custom()[qi] || "").trim();
    if (c) chosen.push(c);
    return chosen;
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

  return (
    <div class="question-card">
      <div class="question-head">
        <Icon name="help" size={15} /> Answer needed
      </div>
      <For each={items()}>
        {(q, qi) => (
          <div class="question-item">
            <Show when={q.header}>
              <div class="question-label">{q.header}</div>
            </Show>
            <div class="question-text">{q.question}</div>
            <Show when={q.options && q.options.length}>
              <div class="question-options" role="group">
                <For each={q.options}>
                  {(opt, oi) => (
                    <button
                      type="button"
                      class="question-opt"
                      classList={{ on: (picked()[qi()] || []).includes(opt.label) }}
                      onClick={() => toggle(qi(), opt.label, q.multiple)}
                    >
                      {/* Display-only key (A:/B:/…) — a separate DOM element so it
                          is never part of the answer value sent to the server. */}
                      <span class="question-opt-key" aria-hidden="true">
                        {String.fromCharCode(65 + (oi() % 26))}:
                      </span>
                      <span class="question-opt-body">
                        <span class="question-opt-label">{opt.label}</span>
                        <Show when={opt.description}>
                          <span class="question-opt-desc">{opt.description}</span>
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            {/* Free-text is allowed unless the question opts out (custom:false) —
                matching opencode, which defaults custom to enabled. */}
            <Show when={q.custom !== false}>
              <input
                class="question-custom"
                type="text"
                placeholder="Type your own answer…"
                value={custom()[qi()] || ""}
                onInput={(e) => setCustom((c) => ({ ...c, [qi()]: e.currentTarget.value }))}
              />
            </Show>
          </div>
        )}
      </For>
      <div class="question-actions">
        <button type="button" class="question-send" disabled={!ready() || busy()} onClick={submit}>
          <Icon name="check" size={14} /> Reply
        </button>
      </div>
    </div>
  );
}
