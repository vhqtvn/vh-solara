// @vitest-environment jsdom
//
// ComposerDispatchPolicy — queue-policy slice B2 (2026-10-29 amendment §2):
// render-level proof of the operator-ratified composer BUTTON TABLE through
// the REAL Composer mount (the same minimal-harness shape as
// ComposerRetryWiring.test.tsx):
//
//   WITH the capability (server advertises queueDispatchPolicyVersion):
//     idle                → Send only (Enter = Send — NEVER a now stamp)
//     busy + empty        → Stop only
//     busy + sendable     → Queue + Send now, NO Stop (the §7 tradeoff)
//     queueMode (legacy setting) no longer gates the busy composer
//
//   WITHOUT the capability: the legacy table byte-for-byte —
//     busy + text + queueMode on → Queue + Stop; queueMode off → Stop only;
//     idle → Send. (Pinned so the feature cannot leak into legacy mode.)
//
// Click routing: Queue → sendPolicy("queue"); Send now → sendPolicy("now").
// Enter while busy routes through the RAW send (the Queue safe default is
// captured inside the controller — pinned in createSendAttempts.test.ts).
// The send semantics themselves are NOT asserted here (controller-seam
// concern); this spec pins the RENDER + wiring only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { Composer, type ComposerProps } from "../../src/components/chat/Composer";
import { setQueueMode } from "../../src/queue";
import {
  __resetQueueDispatchModeForTests,
  refreshDispatchMode,
} from "../../src/lib/queueDispatchMode";

async function enablePolicyCapability() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "t", daemonDispatchCapable: true, queueDispatchPolicyVersion: 1 }),
    })),
  );
  await refreshDispatchMode();
}

function baseProps(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    draft: () => false,
    sessionId: () => "s1",
    isChild: () => false,
    parentId: () => undefined,
    onOpenParent: () => {},
    input: () => "",
    setInput: () => {},
    focusMode: () => false,
    setFocusMode: () => {},
    working: () => false,
    sending: () => false,
    send: async () => {},
    abort: () => {},
    sendInFlight: () => false,
    readyToSend: () => true,
    curModel: () => undefined,
    curVariant: () => "",
    modelDialog: () => false,
    setModelDialog: () => {},
    ac: {
      acItems: () => [],
      acIndex: () => 0,
      acVisible: () => false,
      setAcIndex: () => {},
      applyAc: () => {},
      onAcKeyDown: () => false,
      syncCaret: () => {},
      dismissAc: () => {},
    },
    att: {
      attachments: () => [],
      setAttachments: () => [],
      uploading: () => false,
      uploadProgress: () => null,
      presentInlineIds: () => new Set<string>(),
      removeAttachment: () => {},
      reinsertInlineChip: () => {},
      addFiles: () => {},
      flushPendingAttachments: async (_id: string) => ({ failed: [] }),
      uploadFile: async (_file: File, _id: string) => null,
      inlineFiles: new Map<string, File>(),
    },
    paste: {
      onPaste: () => {},
      pasteFromClipboard: async () => {},
      onPasteButtonDown: () => {},
      onPasteButtonUp: () => {},
      onPasteButtonClick: () => {},
      onPasteButtonBlur: () => {},
    },
    hist: { onHistoryKey: () => false, resetHistory: () => {} },
    recovery: { retract: async () => {}, markSent: async () => {} },
    refTa: () => {},
    refMirror: () => {},
    refFileInput: () => {},
    onPickFile: () => {},
    ...over,
  };
}

afterEach(() => {
  cleanup();
  __resetQueueDispatchModeForTests();
  setQueueMode(true); // restore the legacy default for sibling specs
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function labels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("button.send-btn")).map(
    (b) => b.getAttribute("aria-label") || "",
  );
}

describe("Composer dispatch-policy button table — capability OFF (legacy pin, byte-for-byte)", () => {
  it("idle → Send only (no policy buttons outside the busy state)", () => {
    const r = render(() => <Composer {...baseProps()} />);
    expect(labels(r.container)).toEqual(["Send"]);
    r.unmount();
  });

  it("busy + text + queueMode ON → Queue + Stop (the legacy two-button table)", () => {
    const r = render(() => (
      <Composer {...baseProps({ working: () => true, input: () => "draft text" })} />
    ));
    expect(labels(r.container)).toEqual(["Queue", "Stop"]);
    r.unmount();
  });

  it("busy + text + queueMode OFF → Stop only (the legacy rejection posture's render side)", () => {
    setQueueMode(false);
    const r = render(() => (
      <Composer {...baseProps({ working: () => true, input: () => "draft text" })} />
    ));
    expect(labels(r.container)).toEqual(["Stop"]);
    r.unmount();
  });

  it("busy + EMPTY composer → Stop only (queueMode irrelevant)", () => {
    const r = render(() => <Composer {...baseProps({ working: () => true })} />);
    expect(labels(r.container)).toEqual(["Stop"]);
    r.unmount();
  });

  it("legacy Queue button still routes the RAW send (not a policy entry)", () => {
    const send = vi.fn(async () => {});
    const r = render(() => (
      <Composer {...baseProps({ working: () => true, input: () => "x", send })} />
    ));
    r.container.querySelector<HTMLElement>('button[aria-label="Queue"]')!.click();
    expect(send).toHaveBeenCalledTimes(1);
    // The POLICY entry is a separate prop (sendPolicy) that stays unwired
    // here — the legacy button cannot reach it (pinned by the sendPolicy
    // click-routing cells under the capability-ON describe).
    r.unmount();
  });
});

describe("Composer dispatch-policy button table — capability ON (amendment §2)", () => {
  it("idle → Send only: the policy table NEVER replaces the idle Send (Enter = Send, never a now stamp)", async () => {
    await enablePolicyCapability();
    const r = render(() => (
      <Composer {...baseProps({ sendPolicy: async () => {} })} />
    ));
    expect(labels(r.container)).toEqual(["Send"]);
    r.unmount();
  });

  it("busy + EMPTY composer → Stop only (the amendment's empty-text row)", async () => {
    await enablePolicyCapability();
    const r = render(() => (
      <Composer {...baseProps({ working: () => true, sendPolicy: async () => {} })} />
    ));
    expect(labels(r.container)).toEqual(["Stop"]);
    r.unmount();
  });

  it("busy + text → Queue + Send now, NO Stop (the §7 recorded tradeoff)", async () => {
    await enablePolicyCapability();
    const r = render(() => (
      <Composer
        {...baseProps({ working: () => true, input: () => "busy draft", sendPolicy: async () => {} })}
      />
    ));
    expect(labels(r.container)).toEqual(["Queue", "Send now"]);
    r.unmount();
  });

  it("busy + text + queueMode OFF → the policy buttons STILL render (the setting no longer gates the busy composer)", async () => {
    await enablePolicyCapability();
    setQueueMode(false);
    const r = render(() => (
      <Composer
        {...baseProps({ working: () => true, input: () => "busy draft", sendPolicy: async () => {} })}
      />
    ));
    expect(labels(r.container)).toEqual(["Queue", "Send now"]);
    r.unmount();
  });

  it("busy + ATTACHMENT-ONLY composer (no text) → Queue + Send now (text-only gating removed — amendment §5)", async () => {
    await enablePolicyCapability();
    const att = {
      ...baseProps().att,
      attachments: () => [
        { url: "file:///a.png", filename: "a.png", mime: "image/png" },
      ],
    };
    const r = render(() => (
      <Composer {...baseProps({ working: () => true, att, sendPolicy: async () => {} })} />
    ));
    expect(labels(r.container)).toEqual(["Queue", "Send now"]);
    r.unmount();
  });

  it("Queue click routes sendPolicy(\"queue\"); Send now click routes sendPolicy(\"now\")", async () => {
    await enablePolicyCapability();
    const sendPolicy = vi.fn(async () => {});
    const r = render(() => (
      <Composer
        {...baseProps({ working: () => true, input: () => "busy draft", sendPolicy })}
      />
    ));
    r.container.querySelector<HTMLElement>('button[aria-label="Queue"]')!.click();
    r.container.querySelector<HTMLElement>('button[aria-label="Send now"]')!.click();
    expect(sendPolicy.mock.calls).toEqual([["queue"], ["now"]]);
    r.unmount();
  });

  it("Enter while busy routes the RAW send (the controller captures the Queue safe default at tap)", async () => {
    await enablePolicyCapability();
    const send = vi.fn(async () => {});
    const r = render(() => (
      <Composer
        {...baseProps({ working: () => true, input: () => "busy draft", send })}
      />
    ));
    const ta = r.container.querySelector<HTMLTextAreaElement>(".composer-text")!;
    ta.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith();
    r.unmount();
  });

  it("capability ON but sendPolicy UNWIRED → the legacy table renders (the policy table requires its entry)", async () => {
    await enablePolicyCapability();
    const r = render(() => (
      <Composer {...baseProps({ working: () => true, input: () => "busy draft" })} />
    ));
    expect(labels(r.container)).toEqual(["Queue", "Stop"]);
    r.unmount();
  });
});
