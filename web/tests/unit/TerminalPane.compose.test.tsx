// @vitest-environment jsdom
//
// TerminalPane compose-buffer surface (send-net-resilience cluster D):
//
//  - D-4b-4 PIN: the on-screen key bar's GESTURE keys (esc/tab/^C/arrows)
//    are visibly disabled while input would be buffered (down or suspected
//    half-open) — they cannot be deferred as text and must not silently
//    vanish — while textual bar keys ("|", "~") and the ctrl toggle stay
//    active. Disabled state restores when the link is sendable again.
//  - D-4b-3 (pane side): the pane OBSERVES the server's clean close (code
//    1000 = shell exited) and disposes the compose store entry — held text
//    can never reach a dead shell, and a same-id shell spawned later must
//    not inherit stale holds. (Kill-gesture disposal is pinned in
//    TerminalDock.kill.test.tsx; the never-observed-kill residual is
//    documented in lib/termCompose.ts.)
//  - a-F1: forceReconnect() (the 45s liveness watchdog teardown) must clear
//    the half-open STALE flag at the reconnecting transition — the invariant
//    is enforced at the site, not left to ws.onopen. Surfaced (and pinned)
//    via the pane's data-stale diagnostic attribute.
//  - tier1_c/F1: a pane-SELF close() (disconnect / forceReconnect) is echoed
//    by the server as a code-1000 close event — the SAME shape as shell
//    death — but the PTY lives on. Held text must SURVIVE pane unmount,
//    watchdog socket rotation, and visibility-hide detach; only a
//    SERVER-initiated 1000 close disposes (previous bullet).
//
// Harness notes: @xterm/xterm is canvas-bound and stubbed (the repo-wide
// TerminalDock.zoom.test.tsx judgment); typing is driven through the stub's
// captured onData callback (the real input path). WebSocket is a stub global
// whose lifecycle the test drives from outside (open/message/serverClose).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

// projectDir as a SIGNAL (the GitView.uncertain.test.tsx pattern) so the
// pane reads a stable fake dir.
vi.mock("../../src/sync", async () => {
  const { createSignal } = await import("solid-js");
  const [projectDir] = createSignal("/repo");
  return { projectDir };
});

vi.mock("../../src/ui", async () => {
  const { createSignal } = await import("solid-js");
  const [termKeys] = createSignal(true); // key bar mounted
  return { termKeys };
});

vi.mock("../../src/font", () => ({ monoFontStack: () => "ui-monospace, monospace" }));
vi.mock("../../src/lib/zoom", () => ({ uiZoom: () => 1 }));
vi.mock("../../src/lib/termPointer", () => ({
  pointerToCell: () => ({ inside: false }),
  documentRewriteApplies: () => false,
  rewriteMouseEvent: () => {},
  rewriteWheelEvent: () => {},
}));

// Inert xterm: record the pane's onData subscription (the typing seam) and
// swallow everything canvas-bound. Defined via vi.hoisted so the vi.mock
// factory (hoisted to the top of the file) can reference it.
const { FakeTerm } = vi.hoisted(() => {
  class FakeTerm {
    static instances: FakeTerm[] = [];
    parser = { registerCsiHandler: () => {} };
    onDataCb: ((d: string) => void) | undefined;
    focused = 0;
    written = 0;
    constructor(_opts: unknown) {
      FakeTerm.instances.push(this);
    }
    loadAddon() {}
    open() {}
    reset() {}
    write() { this.written++; }
    focus() { this.focused++; }
    dispose() {}
    onData(cb: (d: string) => void) { this.onDataCb = cb; }
  }
  return { FakeTerm };
});
vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerm }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

import TerminalPane from "../../src/components/TerminalPane";
import { disposeTermCompose, loadTermCompose } from "../../src/lib/termCompose";

// WebSocket stub: lifecycle driven from the tests.
class FakeWS {
  static OPEN = 1 as const;
  static CONNECTING = 0 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  static instances: FakeWS[] = [];
  static get last(): FakeWS {
    return FakeWS.instances[FakeWS.instances.length - 1];
  }
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closeCalledWith: number | undefined;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: unknown) { this.sent.push(d); }
  close(code?: number) {
    this.readyState = 3;
    this.closeCalledWith = code;
    // Platform fidelity (tier1_c/F3): WebSocket.close() without a code ends
    // the handshake with close code 1000, and the server echoes it back —
    // even a pane-SELF teardown observes onclose({code:1000}). Fire it
    // (synchronously; the real event is async, but the harness drives
    // deterministically) so tests can see what self-initiated closes do.
    this.onclose?.({ code: code ?? 1000 });
  }
  // --- test drivers ---
  driveOpen() { this.readyState = 1; this.onopen?.(); }
  driveMessage(data: unknown) { this.onmessage?.({ data }); }
  driveServerClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

const TERM_ID = "t:pane1";

function gestureButtons(container: HTMLElement) {
  // .term-keys children in DOM order: esc, tab, ctrl, ^C, ←, ↑, ↓, →, |, ~
  const bar = container.querySelector(".term-keys");
  expect(bar).not.toBeNull();
  const btns = Array.from(bar!.querySelectorAll<HTMLButtonElement>("button"));
  const byLabel = (label: string) => {
    const b = btns.find((x) => x.textContent === label);
    expect(b, `key-bar button ${label}`).toBeDefined();
    return b!;
  };
  return {
    gestures: ["esc", "tab", "^C", "←", "↑", "↓", "→"].map(byLabel),
    textual: ["|", "~"].map(byLabel),
    ctrl: byLabel("ctrl"),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("WebSocket", FakeWS);
  FakeTerm.instances = [];
  FakeWS.instances = [];
  // The compose store is module state that deliberately survives pane
  // remounts — but each test here models a fresh shell, so start clean.
  disposeTermCompose("/repo", TERM_ID);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TerminalPane — key-bar disable state while buffering (D-4b-4 pin)", () => {
  it("gesture keys disabled while HALF-OPEN STALE with text held; textual keys + ctrl stay active; all restore on recovery", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    // Connected + live: no gesture key is disabled.
    await waitFor(() => {
      const k = gestureButtons(container);
      expect(k.gestures.every((b) => !b.disabled)).toBe(true);
    });

    // Half-open suspicion: socket still OPEN, TERM_STALE_MS (32s) of silence.
    await vi.advanceTimersByTimeAsync(35_000);
    await waitFor(() => {
      expect(container.querySelector(".term-compose")).not.toBeNull(); // buffering affordance visible
    });
    // Hold text through the REAL input path (xterm onData → bufferInput).
    FakeTerm.instances[0].onDataCb!("echo held\r");
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".term-compose-input")!.value).toBe("echo held\n");
    });

    // THE PIN: gesture keys are visibly disabled while buffering…
    const held = gestureButtons(container);
    expect(held.gestures.every((b) => b.disabled)).toBe(true);
    // …while textual keys and the ctrl toggle remain usable.
    expect(held.textual.every((b) => !b.disabled)).toBe(true);
    expect(held.ctrl.disabled).toBe(false);

    // A textual key press appends to the buffer (still never a gesture).
    fireEvent.click(held.textual[0]);
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".term-compose-input")!.value).toBe("echo held\n|");
    });

    // RESTORATION: traffic returns (keepalive) → sendable → keys enabled,
    // held text stays held (only an explicit send flushes it).
    ws.driveMessage(new ArrayBuffer(0));
    await waitFor(() => {
      const k = gestureButtons(container);
      expect(k.gestures.every((b) => !b.disabled)).toBe(true);
    });
    expect(container.querySelector<HTMLTextAreaElement>(".term-compose-input")!.value).toBe("echo held\n|");
  });

  it("explicit Send on the restored link writes exactly the reviewed text to the PTY exactly once", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await vi.advanceTimersByTimeAsync(35_000); // stale → buffering
    FakeTerm.instances[0].onDataCb!("echo sendme\r");
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".term-compose-input")!.value).toBe("echo sendme\n");
    });
    ws.driveMessage(new ArrayBuffer(0)); // restored
    await waitFor(() => {
      expect((container.querySelector(".term-compose-send") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(container.querySelector(".term-compose-send")!);
    // One ws write of the wire-mapped text (LF→CR); buffer + store cleared.
    // (Filter by non-string: the resize control frame is the only string
    // send, and cross-realm Uint8Array defeats instanceof in jsdom.)
    const wireWrites = ws.sent.filter((x) => typeof x !== "string");
    expect(wireWrites.length).toBe(1);
    expect(new TextDecoder().decode(wireWrites[0] as Uint8Array)).toBe("echo sendme\r");
    // Buffer gone + link healthy → the whole strip unmounts (zero friction
    // restored); the store entry is cleared with it.
    await waitFor(() => {
      expect(container.querySelector(".term-compose")).toBeNull();
    });
    expect(loadTermCompose("/repo", TERM_ID)).toBe("");
  });

  it("gesture keys disabled while RECONNECTING after an abnormal drop (the down-socket half of the pin)", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await waitFor(() => {
      expect(gestureButtons(container).gestures.every((b) => !b.disabled)).toBe(true);
    });
    ws.driveServerClose(1006); // abnormal drop → reconnecting
    await waitFor(() => {
      const k = gestureButtons(container);
      expect(k.gestures.every((b) => b.disabled)).toBe(true);
      expect(k.textual.every((b) => !b.disabled)).toBe(true);
    });
  });
});

describe("TerminalPane — compose store disposal on observed shell death (D-4b-3, pane side)", () => {
  it("clean server close (code 1000): the store entry is disposed — a later same-id shell starts clean", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await vi.advanceTimersByTimeAsync(35_000); // stale → buffering
    FakeTerm.instances[0].onDataCb!("echo dying\r");
    await waitFor(() => {
      expect(loadTermCompose("/repo", TERM_ID)).toBe("echo dying\n"); // held in the store…
    });
    // The shell exits: the server's writer closes the socket 1000 ("exit").
    ws.driveServerClose(1000);
    // …and the pane, observing the clean close, disposes the entry.
    await waitFor(() => {
      expect(loadTermCompose("/repo", TERM_ID)).toBe("");
    });
    // The pane surfaces the death honestly (stays down, no reconnect loop)
    // and keeps the dead pane's text VISIBLE for copy (store gone ≠ hidden).
    await waitFor(() => {
      expect(container.querySelector(".term-status")!.classList.contains("disconnected")).toBe(true);
    });
    expect(FakeWS.instances.length).toBe(1); // no reconnect attempted
    expect(container.querySelector<HTMLTextAreaElement>(".term-compose-input")!.value).toBe("echo dying\n");
    // Store-side corroboration: a FRESH pane for the same id (the re-seeded
    // shared-tab shape) mounts with an empty buffer.
    const { container: c2 } = render(() => <TerminalPane termId={TERM_ID} />);
    await waitFor(() => {
      expect(c2.querySelector(".term-status")).not.toBeNull();
    });
    expect(loadTermCompose("/repo", TERM_ID)).toBe("");
  });

  it("abnormal drop does NOT dispose: held text survives the reconnect window (the 4b contract)", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await vi.advanceTimersByTimeAsync(35_000);
    FakeTerm.instances[0].onDataCb!("echo survive\r");
    await waitFor(() => {
      expect(loadTermCompose("/repo", TERM_ID)).toBe("echo survive\n");
    });
    ws.driveServerClose(1006); // abnormal drop → reconnecting (NOT shell death)
    await waitFor(() => {
      expect(container.querySelector(".term-status")!.classList.contains("reconnecting")).toBe(true);
    });
    expect(loadTermCompose("/repo", TERM_ID)).toBe("echo survive\n");
  });
});

describe("TerminalPane — forceReconnect clears stale at the transition (a-F1)", () => {
  it("watchdog teardown: reconnecting window carries data-stale=false, recovery lands open+not-stale", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await vi.advanceTimersByTimeAsync(35_000); // stale (32s) — before the 45s teardown
    const dot = container.querySelector(".term-status")!;
    expect(dot.classList.contains("stale")).toBe(true);
    expect(dot.getAttribute("data-stale")).toBe("true");

    // LIVENESS_MS (45s) of total silence → forceReconnect: socket torn down,
    // status reconnecting. THE PIN: stale must be FALSE through the
    // reconnecting window (enforced at the site, not left to onopen).
    // (Advance to the 50s tick: the watchdog is strictly-greater-than 45s,
    // so the 45s tick itself does not fire it.)
    await vi.advanceTimersByTimeAsync(16_000);
    const dot2 = container.querySelector(".term-status")!;
    expect(dot2.classList.contains("reconnecting")).toBe(true);
    expect(dot2.getAttribute("data-stale")).toBe("false");
    expect(FakeWS.instances.length).toBe(2); // a fresh socket was opened
    expect(ws.closeCalledWith).toBeUndefined(); // torn down via close()

    // Recovery: the fresh socket opens → open + not stale, one shot.
    FakeWS.last.driveOpen();
    await waitFor(() => {
      const dot3 = container.querySelector(".term-status")!;
      expect(dot3.classList.contains("open")).toBe(true);
      expect(dot3.classList.contains("stale")).toBe(false);
      expect(dot3.getAttribute("data-stale")).toBe("false");
    });
  });
});

describe("TerminalPane — pane-SELF teardown preserves the compose store (tier1_c/F1)", () => {
  // The pane's own WebSocket.close() — no code — sends close code 1000
  // (platform contract) and the server echoes the handshake, so onclose
  // observes {code:1000} even when WE tore the socket down. That is the
  // SAME shape as shell death, but the PTY lives on: disposal is gated to
  // SERVER-initiated clean closes only. Each pin holds text, drives one
  // deliberate teardown path, and requires the store entry to survive.

  it("UNMOUNT (dock tab switch / dock close → onCleanup → disconnect) preserves the entry for the remount", async () => {
    const r = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await vi.advanceTimersByTimeAsync(35_000); // stale → buffering
    FakeTerm.instances[0].onDataCb!("echo unmount\r");
    await waitFor(() => {
      expect(loadTermCompose("/repo", TERM_ID)).toBe("echo unmount\n");
    });
    r.unmount(); // the pane's OWN close() — echoed as 1000, PTY still alive
    expect(loadTermCompose("/repo", TERM_ID)).toBe("echo unmount\n"); // PRESERVED
    // The remount shape (tab switch back): a fresh pane restores the hold.
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".term-compose-input")!.value).toBe("echo unmount\n");
    });
  });

  it("watchdog forceReconnect (45s half-open teardown) preserves the entry through the socket rotation", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await vi.advanceTimersByTimeAsync(35_000); // stale → buffering
    FakeTerm.instances[0].onDataCb!("echo rotate\r");
    await waitFor(() => {
      expect(loadTermCompose("/repo", TERM_ID)).toBe("echo rotate\n");
    });
    // → 51s: past LIVENESS_MS — the watchdog closes the socket itself and
    // reconnects (the existing a-F1 rotation). That SELF-close must not
    // read as shell death.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(FakeWS.instances.length).toBe(2); // socket rotated via close()
    expect(ws.closeCalledWith).toBeUndefined(); // no-arg close: code 1000 on the wire
    expect(loadTermCompose("/repo", TERM_ID)).toBe("echo rotate\n"); // PRESERVED
    // The rotated link still delivers: fresh socket opens → sendable again.
    FakeWS.last.driveOpen();
    await waitFor(() => {
      expect((container.querySelector(".term-compose-send") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("visibility-hide detach (hidden tab → disconnect after the grace) preserves the entry", async () => {
    const { container } = render(() => <TerminalPane termId={TERM_ID} />);
    const ws = FakeWS.last;
    ws.driveOpen();
    await vi.advanceTimersByTimeAsync(35_000); // stale → buffering
    FakeTerm.instances[0].onDataCb!("echo hidden\r");
    await waitFor(() => {
      expect(loadTermCompose("/repo", TERM_ID)).toBe("echo hidden\n");
    });
    // Tab hidden → 1.5s grace timer → disconnect() (the pane's OWN close).
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2_000); // past the grace: detach ran
    delete (document as { visibilityState?: string }).visibilityState; // restore jsdom default before any assertion can leak it
    expect(ws.closeCalledWith).toBeUndefined(); // the detach really closed
    expect(loadTermCompose("/repo", TERM_ID)).toBe("echo hidden\n"); // PRESERVED
    // And the still-mounted pane keeps the text VISIBLE for copy.
    expect(container.querySelector<HTMLTextAreaElement>(".term-compose-input")!.value).toBe("echo hidden\n");
  });
});
