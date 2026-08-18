// @vitest-environment jsdom
//
// Composer autocomplete popup under UI zoom — the last known site of the
// viewport-px→style-px class fixed by fc2ef59d/f9a8bbd4 (commit-review F7):
// acStyle() feeds the composer rect's left/width and
// window.innerHeight - r.top + 6 (all VIEWPORT px under CSS `zoom` on :root)
// into the position:fixed popup's inline left/width/bottom, which resolve in
// the popup's ZOOMED-LAYOUT space — converted once at the style boundary via
// layoutPx() (lib/zoom.ts). jsdom returns all-zero rects and cannot apply CSS
// zoom, so the composer rect is stubbed per-element and only the CONVERSION
// arithmetic of the applied inline style is pinned — not live rendering.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
// Install the shared matchMedia stub before the component import graph loads.
import "./_matchMedia";
import { Composer, type ComposerProps } from "../../src/components/chat/Composer";
import type { Attachment } from "../../src/components/chat/createAttachments";
import type { AcItem } from "../../src/lib/complete";

const acItems: AcItem[] = [{ kind: "agent", label: "@build", insert: "@build " }];

const rectOf = (o: Partial<DOMRect>) =>
  ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...o }) as DOMRect;

// Minimal controller fakes — only what Composer's JSX actually reads on this
// path (empty attachments/queue, closed dialogs). Setters are real signals so
// the props typecheck without casts.
function makeProps(acVisible: () => boolean): ComposerProps {
  const [, setInput] = createSignal("");
  const [, setFocusMode] = createSignal(false);
  const [, setModelDialog] = createSignal(false);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  return {
    draft: () => false,
    sessionId: () => "s1",
    isChild: () => false,
    parentId: () => undefined,
    onOpenParent: () => {},
    input: () => "",
    setInput,
    focusMode: () => false,
    setFocusMode,
    working: () => false,
    sending: () => false,
    sendInFlight: () => false,
    readyToSend: () => false,
    curModel: () => undefined,
    curVariant: () => "",
    modelDialog: () => false,
    setModelDialog,
    ac: {
      acItems: () => acItems,
      acIndex: () => 0,
      acVisible,
      setAcIndex: () => {},
      onAcKeyDown: () => false,
      applyAc: () => {},
      dismissAc: () => {},
      syncCaret: () => {},
    },
    att: {
      attachments,
      setAttachments,
      uploading: () => false,
      addFiles: () => {},
      removeAttachment: () => {},
      reinsertInlineChip: () => {},
      flushPendingAttachments: async () => {},
      uploadFile: async () => null,
      inlineFiles: new Map(),
      presentInlineIds: () => new Set<string>(),
    },
    paste: {
      onPaste: () => {},
      pasteFromClipboard: async () => {},
      onPasteButtonDown: () => {},
      onPasteButtonUp: () => {},
      onPasteButtonClick: () => {},
      onPasteButtonBlur: () => {},
    },
    hist: {
      onHistoryKey: () => false,
      resetHistory: () => {},
    },
    recovery: {
      retract: async () => {},
      markSent: async () => {},
    },
    send: async () => {},
    abort: () => {},
    refTa: () => {},
    refMirror: () => {},
    refFileInput: () => {},
    onPickFile: () => {},
  };
}

// Render with the popover hidden, stub the composer rect per-element (jsdom
// reports all-zero gBCRs), then flip visibility so acStyle() runs with the
// stub in place. The popup is portaled to <body>, not the render container.
async function openPop(rect: Partial<DOMRect>): Promise<HTMLElement> {
  const [visible, setVisible] = createSignal(false);
  const { container } = render(() => <Composer {...makeProps(() => visible())} />);
  const composer = container.querySelector(".composer");
  if (!composer) throw new Error(".composer did not render");
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this === composer ? rectOf(rect) : rectOf();
  });
  setVisible(true);
  return waitFor(() => {
    const pop = document.querySelector(".ac-pop");
    if (!pop) throw new Error(".ac-pop did not mount");
    return pop as HTMLElement;
  });
}

describe("Composer autocomplete popup under UI zoom", () => {
  // Composer rect: left=100 top=600 width=400 on the 1024×768 jsdom viewport →
  // bottom gap = round(768 - 600 + 6) = 174.
  const rect = { left: 100, top: 600, width: 400, height: 40, right: 500, bottom: 640 };

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty("--ui-zoom");
  });

  it("zoom 1 is the identity: 100px left / 400px wide / 174px bottom", async () => {
    expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
    document.documentElement.style.setProperty("--ui-zoom", "1");
    const pop = await openPop(rect);
    expect(pop.style.position).toBe("fixed"); // premise: the popup is fixed-positioned
    expect(parseFloat(pop.style.left)).toBeCloseTo(100, 3);
    expect(parseFloat(pop.style.width)).toBeCloseTo(400, 3);
    expect(parseFloat(pop.style.bottom)).toBeCloseTo(174, 3);
  });

  it("125%: converts to layout px (100/1.25=80, 400/1.25=320, 174/1.25=139.2)", async () => {
    document.documentElement.style.setProperty("--ui-zoom", "1.25");
    const pop = await openPop(rect);
    // Pre-fix these rendered as raw 100/400/174 layout-px, so the popup
    // visually landed at 125/500/217.5 (…×1.25) — offset right and oversized
    // by the zoom factor.
    expect(parseFloat(pop.style.left)).toBeCloseTo(80, 3);
    expect(parseFloat(pop.style.width)).toBeCloseTo(320, 3);
    expect(parseFloat(pop.style.bottom)).toBeCloseTo(139.2, 3);
  });

  it("80%: scales up (100/0.8=125, 400/0.8=500, 174/0.8=217.5)", async () => {
    document.documentElement.style.setProperty("--ui-zoom", "0.8");
    const pop = await openPop(rect);
    expect(parseFloat(pop.style.left)).toBeCloseTo(125, 3);
    expect(parseFloat(pop.style.width)).toBeCloseTo(500, 3);
    expect(parseFloat(pop.style.bottom)).toBeCloseTo(217.5, 3);
  });
});
