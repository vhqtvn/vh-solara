import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import type { Permission } from "../types";
import { respondPermission } from "../sync";
import Icon from "./Icon";
import { useCardPopup } from "./cardPopup";

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
  perm: Permission;
}) {
  // Shared popup chrome (open/close + focus capture/restore + ESC + Tab trap).
  // See components/cardPopup.ts. The body is stateless here, so the popup is
  // really "a second render surface for focus"; the trap is what keeps that
  // surface self-contained.
  const popup = useCardPopup();

  const label = () => permLabel(props.perm);
  const detail = () => permDetail(props.perm);
  const act = (resp: string) =>
    respondPermission(props.sessionID, props.perm.id, resp);

  // --- "Always" grant-set reveal ---------------------------------------
  // OpenCode stamps the arity-prefix wildcard patterns a "Always" reply will
  // grant onto the permission request as `always: string[]` (e.g.
  // ["git diff *", "npm run build *"]). The daemon relays the payload
  // untouched (pkg/state/store.go), so the field is already here at runtime —
  // we only surface it so the operator stops approving "Always" blind.
  //
  // Display contract:
  //   • missing/empty `always`        → nothing; the eye + region are absent.
  //   • ["*"] (single catch-all)      → a one-line summary, NOT a bare-* bullet.
  //   • otherwise                     → a capped, scrollable <ul> of patterns.
  //
  // Reveal (inline surface only):
  //   • eye toggle (.perm-eye) PINS the region open until toggled off — the
  //     primary mechanism on touch, where hover is unavailable.
  //   • hovering the "Always" button PEEKS it (desktop pointer:fine only,
  //     gated by matchMedia so synthetic mouseenter on touch never fires it).
  //     The peek does NOT pin — leaving hover re-hides — and never fights the
  //     pin: shown = pin || hover.
  //   • In the popup (body(true)) the region is ALWAYS shown in full: the
  //     popup is the browsable surface for big lists, so no eye/hover there.
  // This is display-only — the server-side never-auto-"always" guard
  // (pkg/web/server.go, perm_policy_test.go) is untouched.
  const [alwaysPinned, setAlwaysPinned] = createSignal(false);
  const [alwaysHover, setAlwaysHover] = createSignal(false);
  const alwaysShown = () => alwaysPinned() || alwaysHover();

  const alwaysList = (): string[] | null => {
    const a = props.perm.always;
    if (!Array.isArray(a) || a.length === 0) return null;
    const ps = a.filter((x) => typeof x === "string" && x);
    return ps.length ? ps : null;
  };
  const isCatchAll = () => {
    const a = alwaysList();
    return !!a && a.length === 1 && a[0] === "*";
  };
  const catchAllText = () =>
    label()
      ? `Always will allow: all future ${label()} requests`
      : "Always will allow: all future requests";

  // Desktop-only hover peek. matchMedia("(hover: hover) and (pointer: fine)")
  // is the JS mirror of the @media query already used in styles.css; gating
  // here keeps touch taps (which can synthesize mouseenter) from revealing.
  const onAlwaysEnter = () => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
    )
      setAlwaysHover(true);
  };
  const onAlwaysLeave = () => setAlwaysHover(false);

  // The reveal region (heading + scrollable list, or the catch-all one-liner).
  // Mounted only when there is something to show; hidden-by-default is handled
  // by the <Show> in body(), not by CSS, so the region is out of the a11y tree
  // entirely until revealed.
  const alwaysRegion = () => {
    const list = alwaysList();
    if (!list) return null;
    return (
      <div class="perm-always" role="region" aria-label="What Always will allow">
        {isCatchAll() ? (
          <p class="perm-always-one">{catchAllText()}</p>
        ) : (
          <>
            <div class="perm-always-head">Always will allow:</div>
            <ul class="perm-always-list">
              <For each={list}>
                {(p) => (
                  <li>
                    <code>{p}</code>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </div>
    );
  };

  // Shared body: the <pre> detail + the three fast actions + (when the
  // permission carries an `always` grant set) the reveal region. Used by both
  // the inline surface and the popup overlay. `inPopup` flips the reveal to
  // "always shown in full" (the popup is the browsable surface for big lists,
  // so it needs no eye/hover) and drops the eye toggle.
  const body = (inPopup = false) => (
    <>
      <Show when={detail()}>
        <pre class="perm-detail">{detail()}</pre>
      </Show>
      <div class="perm-actions">
        <button type="button" onClick={() => act("once")}>
          Allow once
        </button>
        <button
          type="button"
          class="perm-always-btn"
          onClick={() => act("always")}
          // Hover peek is inline-only: the popup always shows the full list
          // (body(true)), so letting the popup's Always button mutate the shared
          // alwaysHover signal would risk leaving it stuck true if the popup
          // unmounts without a mouseleave (ESC/backdrop dismiss) and thus keep
          // the INLINE reveal awkwardly open. Gate the handlers on the surface.
          onMouseEnter={inPopup ? undefined : onAlwaysEnter}
          onMouseLeave={inPopup ? undefined : onAlwaysLeave}
        >
          Always
        </button>
        <Show when={alwaysList() && !inPopup}>
          <button
            type="button"
            class="card-icon-btn perm-eye"
            onClick={() => setAlwaysPinned((v) => !v)}
            aria-label={
              alwaysPinned()
                ? "Hide what Always will allow"
                : "Show what Always will allow"
            }
            aria-expanded={alwaysPinned()}
            data-tip={
              alwaysPinned()
                ? "Hide Always grant set"
                : "Show what Always will allow"
            }
          >
            <Icon name="eye" size={13} />
          </button>
        </Show>
        <button type="button" class="reject" onClick={() => act("reject")}>
          Reject
        </button>
      </div>
      <Show when={alwaysList() && (inPopup || alwaysShown())}>
        {alwaysRegion()}
      </Show>
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
            onClick={popup.show}
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
      <Show when={popup.open()}>
        <Portal>
          <div class="card-pop-overlay" onClick={popup.hide}>
            <div
              ref={popup.setPopRef}
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
                  onClick={popup.hide}
                  aria-label="Close popup"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div class="card-pop-body">{body(true)}</div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
