// @vitest-environment jsdom
//
// AREA 5 — Queued dispatch adapter (dispatchQueuedItem characterization).
//
// dispatchQueuedItem is the network adapter the drainer calls to POST a claimed
// queue item to /oc/session/:id/prompt_async and classify the outcome. This
// pins its three contracts so a future createSend extraction preserves them:
//   (a) real request/body construction (parts from text+attachments, model,
//       agent, messageID threading);
//   (b) 2xx -> {state:"sent"};
//   (c) non-2xx -> {state:"failed", detail} (definitive rejection, never repend);
//   (d) abort/network throw -> {state:"unknown"} (ambiguous, never repend).
//
// Driven through the public drain path: seed a pending item into the in-memory
// queue store, mount a LIVE ChatView (idle), and let the drain-trigger effect
// (createQueueSync) claim + dispatch it. The classification is observed on the
// mocked resolveQueued (mocks.resolve) call args; the request body on the
// prompt_async fetch call.
import "./_chatSendHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import {
  mocks,
  resetAll,
  setupBrowserGlobals,
  teardownBrowserGlobals,
  liveView,
  seedPendingItem,
} from "./_chatSendHarness";

const SID = "s-live";
const PROMPT_URL = `/oc/session/${SID}/prompt_async`;

// Route fetch so the prompt_async endpoint returns a controlled outcome. All
// other URLs return a permissive 200 (ack/attach/etc.).
function routePromptAsync(outcome: { ok?: boolean; status?: number; text?: string; throw?: boolean }) {
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/prompt_async")) {
      if (outcome.throw) throw new Error("network interrupted");
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

function promptAsyncCalls(): any[] {
  return ((globalThis as any).fetch as any).mock.calls.filter((c: any[]) =>
    String(c[0]).includes("/prompt_async"),
  );
}

// The sendConfig threaded onto the seeded item so the dispatch body carries a
// real model + agent (exercises the body-construction path, not the
// captureConfig fallback).
const SEED_CONFIG = { providerID: "openai", modelID: "gpt-4", variant: "high", agent: "gpt-build" };

describe("AREA 5 — dispatchQueuedItem: request construction + outcome classification", () => {
  beforeEach(() => {
    setupBrowserGlobals();
    resetAll();
  });
  afterEach(() => {
    cleanup();
    teardownBrowserGlobals();
  });

  it("(a) constructs the real prompt_async body (parts + model + agent + messageID)", async () => {
    routePromptAsync({ ok: true, status: 204 });
    seedPendingItem(SID, {
      id: "q-1",
      text: "hello world",
      attachments: [],
      sendConfig: SEED_CONFIG,
      opencodeMsgID: "oc-msg-7",
    });
    render(() => liveView(SID));
    // Wait for the drain to dispatch + resolve.
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    const calls = promptAsyncCalls();
    expect(calls.length).toBe(1);
    const [url, opts] = calls[0];
    expect(String(url)).toBe(PROMPT_URL);
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(opts.body);
    // buildParts: text -> one {type:"text"} part.
    expect(body.parts).toEqual([{ type: "text", text: "hello world" }]);
    // model from the captured sendConfig (variant is a SEPARATE top-level body
    // field, NOT nested under model — mirrors dispatchQueuedItem's shape).
    expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-4" });
    expect(body.variant).toBe("high");
    // agent from sendConfig.
    expect(body.agent).toBe("gpt-build");
    // opencodeMsgID threaded as messageID (caller-id-wins correlation).
    expect(body.messageID).toBe("oc-msg-7");
  });

  it("(b) classifies a 2xx response as sent", async () => {
    routePromptAsync({ ok: true, status: 204 });
    seedPendingItem(SID, { id: "q-2", text: "ok send", sendConfig: SEED_CONFIG });
    render(() => liveView(SID));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    const [resolvedSid, itemId, state] = mocks.resolve.mock.calls[0];
    expect(resolvedSid).toBe(SID);
    expect(itemId).toBe("q-2");
    expect(state).toBe("sent");
  });

  it("(c) classifies a non-2xx response as failed (definitive rejection, never repend)", async () => {
    routePromptAsync({ ok: false, status: 500, text: "upstream exploded" });
    seedPendingItem(SID, { id: "q-3", text: "doomed", sendConfig: SEED_CONFIG });
    render(() => liveView(SID));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    const [, itemId, state, detail] = mocks.resolve.mock.calls[0];
    expect(itemId).toBe("q-3");
    expect(state).toBe("failed");
    expect(detail).toContain("upstream exploded");
  });

  it("(d) classifies an abort/network throw as unknown (ambiguous, never repend)", async () => {
    routePromptAsync({ throw: true });
    seedPendingItem(SID, { id: "q-4", text: "maybe sent", sendConfig: SEED_CONFIG });
    render(() => liveView(SID));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    const [, itemId, state] = mocks.resolve.mock.calls[0];
    expect(itemId).toBe("q-4");
    expect(state).toBe("unknown");
  });

  it("excludes synthetic inline-chip attachments from the dispatched file parts", async () => {
    // buildParts MUST skip vh-attach:<localId> chips (they're represented in the
    // text, not as file parts); only real uploaded file:// attachments emit a
    // {type:"file"} part. This pins the isInlineChipUrl guard in buildParts.
    routePromptAsync({ ok: true, status: 204 });
    seedPendingItem(SID, {
      id: "q-5",
      text: "see [img](vh-attach:inl1)",
      attachments: [
        { url: "vh-attach:inl1", filename: "img.png", mime: "image/png" }, // synthetic -> excluded
        { url: "file:///real/x.txt", filename: "x.txt", mime: "text/plain" }, // real -> included
      ],
      sendConfig: SEED_CONFIG,
    });
    render(() => liveView(SID));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    const [, opts] = promptAsyncCalls()[0];
    const body = JSON.parse(opts.body);
    // One text part + ONE file part (the real upload only); the vh-attach: chip
    // is excluded.
    expect(body.parts).toEqual([
      { type: "text", text: "see [img](vh-attach:inl1)" },
      { type: "file", url: "file:///real/x.txt", filename: "x.txt", mime: "text/plain" },
    ]);
  });
});
