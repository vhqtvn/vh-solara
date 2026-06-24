// Scroll-edge affordance: fade the top/bottom edge of a scroll surface ONLY when
// there's hidden content that way, so overflow is visible without arrows (which
// don't compose when scrolls are many/nested). The fade is a CSS mask (see
// .scroll-edges in styles.css) — theme-agnostic (no per-surface bg) and
// nesting-safe (each surface masks itself).
//
// A single global installer tags known scroll surfaces (and any added later —
// dialogs, menus, popovers) so individual components don't need wiring.

const SELECTOR = [
  ".chat-scroll",
  ".tree",
  ".reasoning-body",
  ".tasks-list",
  ".palette-list",
  ".notif-list",
  ".notes-view",
  ".git-body",
  ".dialog-body",
  ".settings-content",
  ".settings-nav",
  ".admin-menu",
  ".managed-dialog",
  ".ctxm-menu",
  ".ctxm-sheet",
  ".confirm-list",
  ".status-menu",
  ".vh-select-pop",
  ".vh-select-sheet",
  ".ac-pop",
].join(",");

const EDGE = 6; // px slack before an edge counts as "more content that way"
const tracked = new WeakSet<Element>();

function attach(el: HTMLElement) {
  if (tracked.has(el)) return;
  tracked.add(el);
  el.classList.add("scroll-edges");
  let raf = 0;
  const update = () => {
    raf = 0;
    el.classList.toggle("se-top", el.scrollTop > EDGE);
    el.classList.toggle("se-bottom", el.scrollHeight - el.scrollTop - el.clientHeight > EDGE);
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  el.addEventListener("scroll", schedule, { passive: true });
  // Container resize AND content growth both change what's hidden.
  new ResizeObserver(schedule).observe(el);
  new MutationObserver(schedule).observe(el, { childList: true, subtree: true, characterData: true });
  schedule();
}

function scan(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches?.(SELECTOR)) attach(root);
  root.querySelectorAll?.<HTMLElement>(SELECTOR).forEach(attach);
}

// Tag current scroll surfaces and watch for ones mounted later.
export function installScrollEdges() {
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) scan(n as Element);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
