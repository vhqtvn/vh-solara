// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { ackSession } from "../../src/sync/orchestration";
import { setSelectedId } from "../../src/sync/actions";
import { state, setState } from "../../src/sync/store";

// Locks in the open-at-bottom ack race fix (P1-WEB-005): the maybeRestore
// no-anchor open path calls ackSession(id, {force:true}) on a fresh page load,
// which can race ahead of Stream-1 arming the FE unread flag. Before the fix,
// ackSession early-returned when !state.unread[root], so the POST /vh/ack never
// reached the server and the dot stuck until a manual scroll. The server's
// clearUnreadLocked is idempotent, so a forced POST is safe; the optimistic
// local clear stays guarded by `armed` to avoid spurious non-unread clears.

function postedCalls(calls: ReturnType<typeof vi.fn>["mock"]["calls"]): { url: string; sid: string }[] {
  const out: { url: string; sid: string }[] = [];
  for (const c of calls) {
    const [url, init] = c as [string, RequestInit];
    if (url !== "/vh/ack") continue;
    let sid = "";
    try {
      sid = JSON.parse(String(init?.body ?? "{}")).sessionID ?? "";
    } catch {
      sid = "";
    }
    out.push({ url, sid });
  }
  return out;
}

beforeEach(() => {
  setState("unread", reconcile({}));
  setState("sessions", reconcile({}));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ackSession — open-at-bottom force flag", () => {
  it("posts /vh/ack even when the FE unread flag is NOT armed yet (force path)", async () => {
    // Simulates maybeRestore firing before Stream-1 arms state.unread on a
    // fresh page load: the dot is armed SERVER-side, but the FE flag is empty.
    expect(state.unread["other"]).toBeFalsy();
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    ackSession("other", { force: true });
    // Flush the fire-and-forget fetch promise chain.
    await Promise.resolve();
    await Promise.resolve();

    const posts = postedCalls(fetchMock.mock.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0].sid).toBe("other");
    // The optimistic local clear is guarded by `armed` — no spurious clear when
    // the FE flag wasn't set.
    expect(state.unread["other"]).toBeFalsy();
  });

  it("does NOT post when unarmed and force is absent (guarded, no redundant POSTs)", async () => {
    expect(state.unread["other"]).toBeFalsy();
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    ackSession("other");
    await Promise.resolve();
    await Promise.resolve();

    expect(postedCalls(fetchMock.mock.calls)).toHaveLength(0);
  });

  it("posts AND optimistically clears when the FE unread flag IS armed", async () => {
    setState("unread", "other", true as unknown as undefined);
    expect(state.unread["other"]).toBeTruthy();
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    ackSession("other");
    await Promise.resolve();
    await Promise.resolve();

    const posts = postedCalls(fetchMock.mock.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0].sid).toBe("other");
    // Optimistic clear fired because armed was true.
    expect(state.unread["other"]).toBeFalsy();
  });
});

// ACK-ON-SELECT (tab-pairs slice): setSelectedId — the ONE selection funnel
// (tree click, palette, notifications, reverse-nav vh-host-select, …) — acks
// the selection server-side so a read on ANY device clears the unread
// watermark everywhere (the cross-device (X|Y) sync requirement). Locks the
// alignment: before this, only bottom-reached scroll gestures acked, so a
// session with a stored mid-history anchor stayed unread-looking on selection.
describe("setSelectedId — ack-on-select alignment", () => {
  it("selecting an unread SUBSESSION acks its ROOT's watermark (root-scoped)", async () => {
    // Tree: root "r" with child "c". Unread is ROOT-scoped server-side, so the
    // watermark lives on "r"; selecting "c" must clear it (ackSession resolves
    // rootOf internally) and POST the raw id (the server resolves root too).
    setState("sessions", "r", { id: "r" });
    setState("sessions", "c", { id: "c", parentID: "r" });
    setState("unread", "r", true as unknown as undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    setSelectedId("c");
    await Promise.resolve();
    await Promise.resolve();

    const posts = postedCalls(fetchMock.mock.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0].sid).toBe("c");
    expect(state.unread["r"], "root watermark optimistically cleared").toBeFalsy();
  });

  it("selecting a non-unread session posts nothing (armed guard, no redundant POSTs)", async () => {
    setState("sessions", "solo", { id: "solo" });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    setSelectedId("solo");
    await Promise.resolve();
    await Promise.resolve();

    expect(postedCalls(fetchMock.mock.calls)).toHaveLength(0);
  });
});
