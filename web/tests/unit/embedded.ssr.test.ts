// @vitest-environment node
//
// SSR pin for the shared embed gate (web/src/embedded.ts): the no-DOM branch.
// `typeof window === "undefined"` → isEmbedded() returns false WITHOUT
// throwing (the guard prefs.ts formerly inlined). embedded.test.ts covers the
// jsdom direction cases, but jsdom always defines window — only this
// node-environment file can exercise the SSR branch.
import { describe, it, expect } from "vitest";
import { isEmbedded } from "../../src/embedded";

describe("isEmbedded — SSR branch (node, no window)", () => {
  it("returns false without throwing when window is undefined", () => {
    expect(typeof window).toBe("undefined"); // guard: this file MUST run without a DOM
    expect(isEmbedded()).toBe(false);
  });
});
