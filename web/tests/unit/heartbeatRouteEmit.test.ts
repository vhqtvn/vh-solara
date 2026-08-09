// @vitest-environment jsdom
//
// CF1 regression: the SPA's cross-origin route emission (web/src/heartbeat.ts)
// must forward ONLY the SPA's known deep-link params (dir, session) — never the
// whole window.location.search. Before the allowlist, any other param present
// in the SPA URL (an OAuth ?code=, a debug flag, an untrusted value) would be
// disclosed + persisted cross-origin to the host, exceeding the declared
// non-sensitive boundary (sync/url.ts writes exactly {dir, session}).
//
// This test also pins the two unchanged invariants the emitter rides on:
//   (a) the route message targets the host origin captured from the inbound
//       handshake (Q2-A — never a literal '*'), and
//   (b) only genuine allowlisted-route changes emit (no spurious repeats when
//       the query is unchanged, AND no emit when ONLY a non-allowlisted param
//       changes — the allowlisted form is unchanged).
// The embed gate + inbound source-guard (ev.source === window.parent) are
// exercised implicitly by the handshake path the emitter requires before any
// post fires.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startHeartbeat } from "../../src/heartbeat";

const HOST_ORIGIN = "https://host.example";
const NONCE = "challenge-nonce-1";

interface Posted {
  msg: { type?: string; route?: string; mountTs?: number } & Record<string, unknown>;
  origin: string;
}

// A fake cross-origin parent: window.parent !== window (embed gate passes) and
// postMessage is captured for assertions (shaped like CodeFrameReady.test.ts's
// spy window).
function makeFakeParent(): { parent: Window; posted: Posted[] } {
  const posted: Posted[] = [];
  const parent = {
    postMessage: (msg: unknown, origin: string) => {
      posted.push({ msg: msg as Posted["msg"], origin });
    },
  } as unknown as Window;
  return { parent, posted };
}

// Dispatch the host→SPA handshake on window. jsdom's MessageEvent does not
// always preserve a programmatically-set `source` (see CodeFrameReady.test.ts),
// so define it explicitly so the inbound source-guard
// (`ev.source === window.parent`) passes. `origin` is the browser-validated
// host origin the SPA must capture (Q2-A).
function sendHandshake(source: Window, origin: string, nonce: string): void {
  const ev = new MessageEvent("message", {
    data: { type: "vh-host-handshake", nonce },
    origin,
  });
  Object.defineProperty(ev, "source", {
    value: source,
    writable: false,
    configurable: true,
  });
  window.dispatchEvent(ev);
}

function setUrl(search: string): void {
  window.history.replaceState({}, "", search === "" ? "/" : `/${search}`);
}

describe("heartbeat route emission — CF1 allowlist (dir+session only)", () => {
  let intervalId: number | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    setUrl("");
    intervalId = undefined;
  });

  afterEach(() => {
    if (intervalId != null) window.clearInterval(intervalId);
    intervalId = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    // Restore window.parent to its jsdom default (window itself).
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: window,
    });
    setUrl("");
  });

  it("forwards only dir+session; drops a poison (non-allowlisted) param", () => {
    // The SPA URL carries a real deep-link PLUS a poison access_token. The
    // emitted route must carry dir+session but NEVER the token or its value.
    setUrl("?dir=/p&session=s&access_token=SECRET");
    const { parent, posted } = makeFakeParent();
    Object.defineProperty(window, "parent", {
      configurable: true,
      get: () => parent,
    });

    intervalId = startHeartbeat();
    // Under fake timers setInterval returns a timer object (not a number); the
    // load-bearing point is that it is defined — i.e. the embed gate passed.
    expect(intervalId, "embed gate passes → interval scheduled").toBeDefined();
    sendHandshake(parent, HOST_ORIGIN, NONCE);

    // One tick: handshake captured → heartbeat + route emitted.
    vi.advanceTimersByTime(250);

    const routeMsgs = posted.filter((p) => p.msg.type === "route");
    expect(routeMsgs.length, "exactly one route message after one tick").toBe(1);

    const route = routeMsgs[0].msg.route ?? "";
    // Decode the emitted route and assert ONLY dir+session survived (encoding-
    // agnostic: the value round-trips regardless of how URLSearchParams
    // serializes it).
    const decoded = new URLSearchParams(route);
    expect(decoded.get("dir"), "dir value forwarded").toBe("/p");
    expect(decoded.get("session"), "session value forwarded").toBe("s");
    expect(decoded.get("access_token"), "poison param dropped").toBeNull();
    // Belt-and-suspenders: the secret value must not appear anywhere in the
    // raw string that crosses the origin boundary.
    expect(route, "secret value never crosses to the host").not.toContain("SECRET");
    expect(route, "poison param name never crosses to the host").not.toContain("access_token");
  });

  it("targets the captured host origin — never '*'", () => {
    setUrl("?dir=/x");
    const { parent, posted } = makeFakeParent();
    Object.defineProperty(window, "parent", {
      configurable: true,
      get: () => parent,
    });

    intervalId = startHeartbeat();
    sendHandshake(parent, HOST_ORIGIN, NONCE);
    vi.advanceTimersByTime(250);

    // EVERY posted message (heartbeat + route) went to the captured host
    // origin exactly — none to the wildcard.
    expect(posted.length, "at least heartbeat + route posted").toBeGreaterThan(0);
    for (const p of posted) {
      expect(p.origin, "every reply uses the captured host origin").toBe(HOST_ORIGIN);
      expect(p.origin, "no reply ever uses the wildcard '*'").not.toBe("*");
    }
    const routeMsgs = posted.filter((p) => p.msg.type === "route");
    expect(routeMsgs.length).toBe(1);
    expect(routeMsgs[0].origin, "route reply origin-targeted").toBe(HOST_ORIGIN);
  });

  it("emits only on a genuine allowlisted-route change (no spurious repeats)", () => {
    const { parent, posted } = makeFakeParent();
    Object.defineProperty(window, "parent", {
      configurable: true,
      get: () => parent,
    });
    intervalId = startHeartbeat();
    sendHandshake(parent, HOST_ORIGIN, NONCE);

    const routeMsgs = () => posted.filter((p) => p.msg.type === "route");

    // 1. A real deep-link → emit once.
    setUrl("?dir=/a&session=1");
    vi.advanceTimersByTime(250);
    expect(routeMsgs().length, "first genuine change emits one route").toBe(1);

    // 2. Adding ONLY a non-allowlisted param (debug=1) does NOT emit — the
    //    allowlisted form (?dir=/a&session=1) is unchanged, so a poison/debug
    //    param cannot manufacture traffic to the host.
    setUrl("?dir=/a&session=1&debug=1");
    vi.advanceTimersByTime(250);
    expect(routeMsgs().length, "non-allowlisted-only change does not emit").toBe(1);

    // 3. A genuine change to an allowlisted param (session 1 → 2) emits again.
    setUrl("?dir=/a&session=2");
    vi.advanceTimersByTime(250);
    expect(routeMsgs().length, "allowlisted change emits a second route").toBe(2);

    // 4. No change → no repeat (heartbeat still fires; route does not).
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(250);
    expect(routeMsgs().length, "unchanged query does not re-emit").toBe(2);
  });
});
