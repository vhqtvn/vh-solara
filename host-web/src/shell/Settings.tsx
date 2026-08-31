import { For, Show, createSignal, onCleanup } from "solid-js";
import { autoTransposeOn, setAutoTranspose } from "../viewportShape";
import {
  attentionNotifyHint,
  attentionNotifyOn,
  requestEnableAttentionNotify,
  setAttentionNotifyEnabled,
} from "../attentionNotify";
import { focusedId, hostOps } from "../dockview/store";
import { getLayoutDiagRing } from "../dockview/layoutDiag";
import { TABSTRIP_POPOVER_GROUP, usePopoverSurface } from "./popover";
import s from "./Settings.module.css";

/**
 * Host-shell SETTINGS popover (tabstrip gear) — the host's only settings
 * surface (the statusbar and per-pane headers are both gone, so after a
 * deploy the operator had no way to reload short of summoning a keyboard).
 *
 * OPEN/CLOSE goes through the shared surface stack (popover.ts), the SAME
 * primitive AddServer + Layouts use: Escape closes (topmost-only — with the
 * layout overlay also open, one Escape dismisses only the topmost surface), a
 * pointerdown outside the wrap closes, and the tabstrip group keeps this
 * popover mutually exclusive with the other tabstrip popovers. The listeners
 * live only while a surface is open — no shell-lifetime document handlers.
 * Pane taps close it too: pointerdown on a CROSS-ORIGIN IFRAME never reaches
 * this document, so the SPA's forwarded pane-activate gesture drives the same
 * dismissal (routeMessage → dismissAnchoredSurfaces) — Escape + any
 * host-chrome or pane tap do.
 *
 * EXTENSIBLE BY DESIGN: the menu items are a plain typed array below. Adding
 * a future setting = appending one entry (action or toggle); no rendering
 * changes. A persisted toggle stays live automatically when its `isOn` reads
 * a storage-synced reactive accessor (see viewportShape.autoTransposeOn).
 * Items are host-chrome ONLY (no iframe lifecycle impact) and all GPU-cheap
 * CSS (plain bg/border — no mask-image/backdrop-filter/contain).
 *
 * Production-capable: the toggle reads/writes viewportShape's localStorage
 * helpers (NOT the DEV bridge). The auto-rotate item applies LIVE because
 * viewportShape.applyTranspose re-reads the key on EVERY evaluation — no
 * reload needed.
 *
 * "Edit layout…" is the host-side, no-gesture entry to the layout overlay
 * (the statusbar removal in aa244b3 had left the overlay gesture-only). It
 * routes through the production HostOps path (hostOps().openLayoutOverlay)
 * anchored to the focused pane, closes this popover on activation (surface
 * handoff), and is aria-disabled + dimmed when no pane is focused. The label
 * was renamed from "Layout…" in the named-layouts de-confusion slice: this
 * menu previously ALSO carried "Layouts…" (the saved-layouts manager), and
 * the two near-identical labels with different functions were the confusion —
 * the manager now lives in its own tabstrip "Layouts" popover (Layouts.tsx).
 */

/** A one-shot menu entry (runs an action when activated). */
interface ActionItem {
  kind: "action";
  testid: string;
  label: string;
  description: string;
  /** Disabled accessor, read reactively while the popover is open (the JSX
   *  attributes below call it inside their expressions, so SolidJS tracks it).
   *  A disabled action renders aria-disabled + a dimmed non-interactive style
   *  and activation is a full no-op. The button itself stays focusable so
   *  keyboard/screen-reader users can still discover the entry. */
  disabled?(): boolean;
    /** When true, activating this action CLOSES the popover after run() — for
   *  actions whose result is the NEXT surface (Edit layout… opens the layout
   *  overlay; two popovers open at once is confusing). */
  closeAfterRun?: boolean;
  /** Optional reactive inline hint rendered under the description when
   *  non-null (e.g. the copy-diagnostics item's transient "Copied" feedback).
   *  Same shape as ToggleItem.hint — declared per-kind so the union stays a
   *  plain structural match. */
  hint?(): string | null;
  run(): void;
}

/** A boolean menu entry (aria-checked checkbox semantics). `isOn` is read
 * reactively (a Solid signal accessor) so the checkmark tracks the state. */
interface ToggleItem {
  kind: "toggle";
  testid: string;
  label: string;
  description: string;
  isOn(): boolean;
  set(on: boolean): void;
  /** Optional reactive inline hint rendered under the description when
   *  non-null (e.g. a permission denial explaining how to unblock). Reads a
   *  signal accessor so it appears/disappears live while the popover is open. */
  hint?(): string | null;
}

type MenuItem = ActionItem | ToggleItem;

export function Settings() {
  let wrapEl: HTMLDivElement | undefined;

  const surface = usePopoverSurface({
    id: "settings",
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => wrapEl,
  });

  // ---- "Copy layout diagnostics" action (production-capable) ---------------
  // Copies the layout-persistence diag ring (layoutDiag.ts — always-on, last
  // 30 events, persisted across relaunches) as JSON to the clipboard. This is
  // the operator's one-tap evidence-collection path for the on-device PWA
  // relaunch loss: reproduce → Settings → Copy → paste back. Async clipboard
  // first; when unavailable/denied (non-secure origin LAN http, older mobile
  // browsers) a readonly textarea is staged + selected as the fallback (the
  // PerformanceDialog/pwa-probe pattern). Inline "Copied"/"selected" feedback
  // under the item.
  const [diagHint, setDiagHint] = createSignal<string | null>(null);
  const [diagFallback, setDiagFallback] = createSignal<string | null>(null);
  let diagFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let diagTextarea: HTMLTextAreaElement | undefined;

  const flashDiagHint = (text: string): void => {
    setDiagHint(text);
    if (diagFlashTimer !== undefined) clearTimeout(diagFlashTimer);
    diagFlashTimer = setTimeout(() => setDiagHint(null), 2500);
  };

  const copyDiagnostics = (): void => {
    const text = JSON.stringify(getLayoutDiagRing());
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setDiagFallback(null);
        flashDiagHint("Copied to clipboard ✓");
        return;
      } catch {
        /* clipboard unavailable/denied — fall through to the textarea */
      }
      setDiagFallback(text);
      flashDiagHint("Selected below — copy from the text box");
      queueMicrotask(() => {
        diagTextarea?.focus();
        diagTextarea?.select();
      });
    })();
  };

  onCleanup(() => {
    if (diagFlashTimer !== undefined) clearTimeout(diagFlashTimer);
  });

  // The menu. Append entries here; the <For> below renders both kinds.
  // The auto-rotate toggle's isOn reads autoTransposeOn — a REACTIVE mirror
  // of the persisted key that tracks every writer (same-document writes via
  // setAutoTranspose — including the DEV bridge — and cross-document writes
  // via the storage event), so the checkmark can never go stale while the
  // popover is open (finding 7).
  //
  // "Edit layout…" (FIRST — the most frequent action) restores a host-side,
  // production-capable, NO-GESTURE trigger for the layout overlay: since the
  // statusbar removal (aa244b3) the overlay was gesture-only (double-Ctrl /
  // triple-tap), leaving no fallback if gestures fail on a device. It routes
  // through the SAME production HostOps path the gesture does
  // (hostOps().openLayoutOverlay), anchored to the FOCUSED pane, and is
  // disabled (aria-disabled + dimmed, click = no-op) when no pane is focused
  // (empty workspace) because the overlay must anchor to a pane.
  const items: MenuItem[] = [
    {
      kind: "action",
      testid: "settings-layout",
      label: "Edit layout…",
      description: "Split, swap, or close the focused pane.",
      disabled: () => !focusedId(),
      closeAfterRun: true,
      run: () => {
        const id = focusedId();
        if (id) hostOps()?.openLayoutOverlay?.(id);
      },
    },
    {
      kind: "action",
      testid: "settings-reload",
      label: "Reload page",
      description: "Load the freshly deployed version.",
      run: () => location.reload(),
    },
    {
      kind: "toggle",
      testid: "settings-autorotate",
      label: "Auto-rotate layout",
      description: "Flip split orientation when the viewport rotates.",
      isOn: () => autoTransposeOn(),
      set: (v) => setAutoTranspose(v),
    },
    {
      // Needs-you notifications (attentionNotify.ts). OPT-IN: absent key =
      // OFF. Enabling goes through requestEnableAttentionNotify() so the
      // permission prompt (if any) fires from THIS click's user gesture; a
      // denied/declined grant leaves the toggle off + surfaces `hint` (an
      // inline line under the description, live while the popover is open).
      // The checkmark tracks attentionNotifyOn() — the reactive mirror, which
      // flips only when a grant actually landed (possibly a tick after the
      // click, since requestPermission is async).
      kind: "toggle",
      testid: "settings-notify",
      label: "Needs-you notifications",
      description: "OS notification when a session needs you (opt-in).",
      isOn: () => attentionNotifyOn(),
      set: (v) => {
        if (v) void requestEnableAttentionNotify();
        else setAttentionNotifyEnabled(false);
      },
      hint: () => attentionNotifyHint(),
    },
    {
      // Evidence collection for the on-device PWA relaunch layout loss
      // (2026-08-31 diagnosis-first slice). The diag ring records the init
      // read source/origin, every flush (trigger+bytes+ws), seeds, and clears
      // — always-on in production. Kept the popover open (no closeAfterRun)
      // so the "Copied" feedback (and the fallback textarea below) stay
      // visible.
      kind: "action",
      testid: "settings-copy-diag",
      label: "Copy layout diagnostics",
      description: "Copy the persistence event log (last 30) as JSON.",
      run: copyDiagnostics,
      hint: diagHint,
    },
  ];

  const activate = (item: MenuItem) => {
    if (item.kind === "action") {
      // A disabled action is a full no-op — no run, no close-after-run (the
      // popover stays open so the operator can still pick another entry).
      if (item.disabled?.()) return;
      item.run();
      // Reload navigates anyway; closeAfterRun actions (Edit layout…) hand off
      // to their surface as the next one open.
      if (item.closeAfterRun) surface.closePopover();
      return;
    }
    item.set(!item.isOn());
    // A toggle keeps the popover open (the operator may flip several
    // settings in one visit); the state change is visible in-place.
  };

  return (
    <div class={s.wrap} ref={wrapEl}>
      <button
        type="button"
        class={s.trigger}
        title="Settings"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={surface.open() ? "true" : "false"}
        data-testid="settings-btn"
        onClick={() => surface.togglePopover()}
      >
        <span class={s.triggerIcon} aria-hidden="true">⚙</span>
      </button>
      <Show when={surface.open()}>
        <div class={s.popover} role="menu" data-testid="settings-popover" aria-label="Settings">
          <div class={s.heading}>Settings</div>
          <div class={s.menu} role="presentation">
            <For each={items}>
              {(item) => (
                <button
                  type="button"
                  // The disabled accessor is CALLED in the class/aria-disabled
                  // expressions so SolidJS tracks it — the state is live while
                  // the popover is open and re-derived on every open (the
                  // <Show> content remounts).
                  class={
                    item.kind === "action" && item.disabled?.()
                      ? `${s.item} ${s.itemDisabled}`
                      : s.item
                  }
                  data-testid={item.testid}
                  role={item.kind === "toggle" ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={item.kind === "toggle" ? (item.isOn() ? "true" : "false") : undefined}
                  // aria-disabled (NOT the native disabled attr): the button
                  // stays focusable/discoverable; the dimmed style + activate's
                  // guard make it non-interactive.
                  aria-disabled={
                    item.kind === "action" && item.disabled?.() ? "true" : undefined
                  }
                  onClick={() => activate(item)}
                >
                  <span class={s.itemText}>
                    <span class={s.itemLabel}>{item.label}</span>
                    <span class={s.itemDesc}>{item.description}</span>
                    {/* Optional live hint line (permission denial guidance,
                        copy-diagnostics "Copied" feedback). Called in the JSX
                        expression so SolidJS tracks the hint signal while the
                        popover is open. */}
                    {item.hint ? (
                      <Show when={item.hint()} keyed>
                        {(h) => (
                          <span class={s.itemHint} data-testid={`${item.testid}-hint`}>
                            {h}
                          </span>
                        )}
                      </Show>
                    ) : null}
                  </span>
                  {item.kind === "toggle" ? (
                    /* Cheap checkbox affordance: a bordered square with a ✓
                       glyph when on. Plain bg/border — no GPU-heavy CSS. */
                    <span class={s.itemCheck} aria-hidden="true">
                      <Show when={item.isOn()}>
                        <span class={s.itemCheckMark}>✓</span>
                      </Show>
                    </span>
                  ) : null}
                </button>
              )}
            </For>
          </div>
          {/* Copy-diagnostics FALLBACK: a readonly textarea staged with the
              ring JSON and selected, for browsers where the async clipboard is
              unavailable or denied (non-secure LAN origins — the operator's
              http device path). Rendered only while the fallback is active. */}
          <Show when={diagFallback()}>
            <textarea
              class={s.diagTextarea}
              ref={diagTextarea}
              readonly
              data-testid="settings-diag-textarea"
              value={diagFallback() ?? ""}
              spellcheck={false}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}
