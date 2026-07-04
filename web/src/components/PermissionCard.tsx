import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { respondPermission } from "../sync";
import Icon from "./Icon";

// Category label for a permission request (best-effort: the structured fields
// OpenCode sends, in priority order). Moved here verbatim from ChatView so the
// permission card is a self-contained, extracted component.
function permLabel(p: any): string {
  return String(p?.permission || p?.type || p?.title || "").trim();
}

// Human-readable detail for the <pre> block: the structured command/path the
// tool wants to run, falling back to the patterns list. No markdown —
// permissions keep a plain <pre>.
function permDetail(p: any): string {
  const m = (p?.metadata || {}) as Record<string, any>;
  const cand = m.command ?? m.cmd ?? m.filePath ?? m.path ?? m.description ?? m.title;
  if (typeof cand === "string" && cand.trim()) return cand.trim();
  if (Array.isArray(p?.patterns)) {
    const ps = p.patterns.filter(
      (x: any) => typeof x === "string" && x && x !== "*",
    );
    if (ps.length) return ps.join("\n");
  }
  return "";
}

// Extracted permission card. Keeps the three inline fast actions
// (Allow once / Always / Reject) calling respondPermission with the SAME
// signature as before. No H/V toggle, no markdown body. Like QuestionCard, it
// owns a popup-open signal and renders the SAME body() in both the inline
// surface and a Portal overlay so the two stay synchronized (the body is
// stateless here, so this is really "a second render surface for focus").
export default function PermissionCard(props: {
  sessionID: string;
  perm: any;
}) {
  const [popupOpen, setPopupOpen] = createSignal(false);
  let lastFocus: HTMLElement | null = null;
  let popRef: HTMLDivElement | undefined;

  const label = () => permLabel(props.perm);
  const detail = () => permDetail(props.perm);
  const act = (resp: string) =>
    respondPermission(props.sessionID, props.perm.id, resp);

  const openPopup = () => {
    lastFocus = document.activeElement as HTMLElement | null;
    setPopupOpen(true);
    queueMicrotask(() => popRef?.focus());
  };
  const closePopup = () => {
    setPopupOpen(false);
    queueMicrotask(() => lastFocus?.focus?.());
  };
  createEffect(() => {
    if (!popupOpen()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopup();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  // Shared body: the <pre> detail + the three fast actions. Used by both the
  // inline surface and the popup overlay.
  const body = () => (
    <>
      <Show when={detail()}>
        <pre class="perm-detail">{detail()}</pre>
      </Show>
      <div class="perm-actions">
        <button type="button" onClick={() => act("once")}>
          Allow once
        </button>
        <button type="button" onClick={() => act("always")}>
          Always
        </button>
        <button type="button" class="reject" onClick={() => act("reject")}>
          Reject
        </button>
      </div>
    </>
  );

  const titleNode = () => (
    <>
      🔒 Permission requested
      <Show when={label()}>
        : <strong>{label()}</strong>
      </Show>
    </>
  );

  return (
    <div class="perm-card">
      <div class="perm-head">
        <div class="perm-title">{titleNode()}</div>
        <span class="card-tools">
          <button
            type="button"
            class="card-icon-btn"
            onClick={openPopup}
            data-tip="Open in popup"
            aria-label="Open permission in popup"
          >
            <Icon name="maximize" size={13} />
          </button>
        </span>
      </div>

      {/* Inline in-stream surface. */}
      {body()}

      {/* Popup surface — mirrors the card (shared body) for long <pre> focus. */}
      <Show when={popupOpen()}>
        <Portal>
          <div class="card-pop-overlay" onClick={closePopup}>
            <div
              ref={popRef}
              class="card-pop card-pop-perm"
              role="dialog"
              aria-modal="true"
              aria-label="Permission requested"
              tabindex="-1"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="card-pop-head">
                <span class="card-pop-title">{titleNode()}</span>
                <button
                  type="button"
                  class="card-icon-btn"
                  onClick={closePopup}
                  aria-label="Close popup"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div class="card-pop-body">{body()}</div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
