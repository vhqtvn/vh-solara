// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TREE_STREAM_KINDS } from "../../src/sync/stream";

// Pins Stream 1's (tree stream) EventSource listener-registration list.
// applyMessageEvent's handler cases are reachable ONLY for the kinds registered
// here: EventSource delivers a NAMED event solely to a matching addEventListener
// call, so a handler case with no listener is silently dead on the wire. The
// cold-chip regression was exactly that — `case "lastAgent.set"` existed in
// applyMessageEvent but the registration list omitted "lastAgent.set", so the
// SSE frame was dropped in production while every unit test stayed green (they
// invoke applyMessageEvent directly, bypassing registration). This test fails
// the moment a live-pushed facet is added to applyMessageEvent but forgotten in
// the registration list.

describe("Stream 1 EventSource kind registration (TREE_STREAM_KINDS)", () => {
  it("registers lastAgent.set — the cold-seed live-patch facet", () => {
    // The cold-chip fix: SetLastAgents emits lastAgent.set on the wire; without
    // a listener here the per-agent chip stays blank for un-opened sessions.
    expect(TREE_STREAM_KINDS).toContain("lastAgent.set");
  });

  it("registers activity.verb — the mirrored snapshot-only facet", () => {
    // Guards against regressing the pre-existing live-patch facet this fix mirrors.
    expect(TREE_STREAM_KINDS).toContain("activity.verb");
  });

  it("does NOT register message.* (Stream 2 only) or session.* (applySessionEvent)", () => {
    // message.* belong to Stream 2 (active-session); session.upsert/delete route
    // through applySessionEvent (registered in a separate loop). Their presence
    // here would be a wiring mistake — applyMessageEvent has no useful case for
    // them and would no-op the event.
    for (const k of TREE_STREAM_KINDS) {
      expect(k.startsWith("message.")).toBe(false);
      expect(k.startsWith("session.")).toBe(false);
    }
  });
});
