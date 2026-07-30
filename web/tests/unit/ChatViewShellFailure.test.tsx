// @vitest-environment jsdom
//
// AREA 4 — Shell failure behavior (send-cluster characterization).
//
// Pins runShell()/dispatchSend() so a future createSend extraction preserves:
//   - a FAST non-2xx failure surfaces immediately and RESTORES the original
//     "!command" composer text (no silent loss);
//   - a network rejection likewise restores;
//   - the 2.5-second ACCEPTED race (ACCEPTED_AFTER_MS): once a shell POST has
//     run 2500ms without a fast settle, the per-session guard releases and the
//     send is treated as accepted (composer stays cleared) — explicitly pinned
//     at the 2500ms boundary (just-under still in-flight, at-boundary accepted).
//
// Shell dispatches use the sync store's setSending/isSending guard (NOT the
// enqueue single-flight), so we gate settle on isSending(SID). The shell branch
// does setInput("") BEFORE runShell and restores setInput(text) only on failure.
import "./_chatSendHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { fireEvent } from "@testing-library/dom";
import { isSending } from "../../src/sync";
import {
  resetAll,
  setupBrowserGlobals,
  teardownBrowserGlobals,
  liveView,
  typeInto,
  composerValue,
  clickSend,
} from "./_chatSendHarness";

const SID = "s-live";
const SHELL_URL = `/oc/session/${SID}/shell`;

// Route globalThis.fetch so the shell endpoint returns a controlled outcome.
// Everything else returns a permissive 200.
function routeShell(outcome: { ok?: boolean; status?: number; text?: string; throw?: boolean }) {
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/shell")) {
      if (outcome.throw) throw new Error("network down");
      return {
        ok: outcome.ok ?? true,
        status: outcome.status ?? 200,
        json: async () => ({}),
        text: async () => outcome.text ?? "",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  });
}

function shellCalls(): any[] {
  return ((globalThis as any).fetch as any).mock.calls.filter((c: any[]) =>
    String(c[0]).includes("/shell"),
  );
}

describe("AREA 4 — shell (!command) failure behavior", () => {
  beforeEach(() => {
    setupBrowserGlobals();
    resetAll();
  });
  afterEach(() => {
    cleanup();
    teardownBrowserGlobals();
  });

  it("(1) a fast non-2xx failure RESTORES the original !command (no silent loss)", async () => {
    routeShell({ ok: false, status: 400, text: "bad shell" });
    const { container } = render(() => liveView(SID));
    typeInto(container, "!echo hi");
    await clickSend(container);
    // send() suspends at its first await (ensureSession) BEFORE the shell branch,
    // so wait for the shell POST to actually fire first — then for the restore.
    await waitFor(() => expect(shellCalls()).toHaveLength(1));
    await waitFor(() => expect(composerValue(container)).toBe("!echo hi"));
    const [, opts] = shellCalls()[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual(expect.objectContaining({ command: "echo hi" }));
    // The restore happens AFTER the dispatch finally releases the guard, so by
    // the time composerValue is restored the per-session guard is released.
    expect(isSending(SID)).toBe(false);
  });

  it("(2) a network rejection RESTORES the original !command", async () => {
    routeShell({ throw: true });
    const { container } = render(() => liveView(SID));
    typeInto(container, "!rm -rf");
    await clickSend(container);
    await waitFor(() => expect(shellCalls()).toHaveLength(1));
    await waitFor(() => expect(composerValue(container)).toBe("!rm -rf"));
    expect(isSending(SID)).toBe(false);
  });

  it("(3) the 2.5s ACCEPTED race: just-under-2500ms still in-flight; at 2500ms accepted + guard released", async () => {
    // The fetch hangs (models a long/hung turn that never settles fast). The race
    // must release the guard and treat the send as accepted at exactly 2500ms.
    vi.useFakeTimers();
    try {
      (globalThis as any).fetch = vi.fn(() => new Promise(() => {})); // never resolves
      const { container } = render(() => liveView(SID));
      typeInto(container, "!long-running");
      const btn = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      fireEvent.click(btn);
      // Flush microtasks so send() reaches dispatchSend and arms the 2500ms timer.
      await vi.advanceTimersByTimeAsync(0);
      // The shell branch already cleared the composer (setInput("")).
      expect(composerValue(container)).toBe("");
      // Just UNDER 2500ms: dispatch still in-flight, guard still held.
      await vi.advanceTimersByTimeAsync(2499);
      expect(isSending(SID)).toBe(true);
      // AT the 2500ms boundary: the accepted race fires -> guard released.
      await vi.advanceTimersByTimeAsync(2);
      expect(isSending(SID)).toBe(false);
      // Accepted => no restore => composer stays cleared (the reply streams in
      // via the event feed; the composer is never frozen on a long/hung turn).
      expect(composerValue(container)).toBe("");
      expect(shellCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(4) a shell POST accepted before 2500ms (fast success) honors the fast settle", async () => {
    // If the shell POST resolves 2xx BEFORE the 2500ms grace, the race honors
    // it immediately (resolves true) and releases the guard — no need to wait
    // the full grace period. Distinct from the hang case above.
    routeShell({ ok: true, status: 200 });
    const { container } = render(() => liveView(SID));
    typeInto(container, "!echo ok");
    await clickSend(container);
    // Accepted fast -> ok=true -> no restore -> composer stays cleared.
    await waitFor(() => expect(shellCalls()).toHaveLength(1));
    await waitFor(() => expect(isSending(SID)).toBe(false));
    expect(composerValue(container)).toBe("");
  });
});
