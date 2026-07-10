import { createEffect, createSignal, Show } from "solid-js";
import Icon from "./Icon";
import styles from "./TextPromptDialog.module.css";

// A DOM text-input dialog replacing window.prompt (which spawns a separate OS
// window under tiling WMs). Desktop-centered / mobile bottom-sheet via CSS.
// Enter confirms, Escape/backdrop cancels; the input is focused + selected.
export default function TextPromptDialog(props: {
  open: boolean;
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (props.open) {
      setVal(props.initial ?? "");
      queueMicrotask(() => {
        inputRef?.focus();
        inputRef?.select();
      });
    }
  });

  const submit = () => {
    const v = val().trim();
    if (v) props.onConfirm(v);
  };

  return (
    <Show when={props.open}>
      <div class="dialog-overlay" onClick={props.onCancel}>
        <div class="dialog confirm vh-prompt" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
          <div class="dialog-head">
            <span class="dialog-title">{props.title}</span>
            <button type="button" class="icon-btn" aria-label="Close" onClick={props.onCancel}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div class="dialog-body">
            <Show when={props.label}>
              <label class={styles["vh-prompt-label"]}>{props.label}</label>
            </Show>
            <input
              ref={inputRef}
              class="vh-prompt-input"
              type="text"
              value={val()}
              placeholder={props.placeholder}
              onInput={(e) => setVal(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  props.onCancel();
                }
              }}
            />
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel" onClick={props.onCancel}>
              Cancel
            </button>
            <button type="button" class="confirm-go" onClick={submit}>
              {props.confirmText ?? "OK"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
