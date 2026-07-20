// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// protocol.ts uses a module-level signal, so reset the module graph between
// tests to start each case from a clean pendingProtocol() state.
async function freshModule() {
  vi.resetModules();
  return await import("../../src/protocol");
}

describe("protocol handler: parse + confirm-before-act contract", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.resetModules();
  });

  describe("parseProtocolPayload (pure)", () => {
    it("returns null when there is no proto param", async () => {
      const { parseProtocolPayload } = await freshModule();
      expect(parseProtocolPayload("")).toBeNull();
      expect(parseProtocolPayload("?dir=%2Fwork")).toBeNull();
      expect(parseProtocolPayload("?session=abc&dir=x")).toBeNull();
    });

    it("returns null for an empty/whitespace proto value", async () => {
      const { parseProtocolPayload } = await freshModule();
      expect(parseProtocolPayload("?proto=")).toBeNull();
      expect(parseProtocolPayload("?proto=%20%20")).toBeNull();
    });

    it("URL-decodes the percent-encoded payload", async () => {
      const { parseProtocolPayload } = await freshModule();
      // Chrome substitutes %s with the percent-encoded URL, so a literal '+'
      // in the scheme arrives as %2B and ':' as %3A.
      const payload = parseProtocolPayload("?proto=web%2Bvhsolara%3Asession%2Fabc");
      expect(payload).toBe("web+vhsolara:session/abc");
    });

    it("preserves additional query params alongside proto", async () => {
      const { parseProtocolPayload } = await freshModule();
      const payload = parseProtocolPayload("?proto=web%2Bvhsolara%3Ax&dir=%2Fwork");
      expect(payload).toBe("web+vhsolara:x");
    });

    it("accepts a leading-? or bare search string", async () => {
      const { parseProtocolPayload } = await freshModule();
      expect(parseProtocolPayload("?proto=web%2Bvhsolara%3Aa")).toBe("web+vhsolara:a");
      expect(parseProtocolPayload("proto=web%2Bvhsolara%3Aa")).toBe("web+vhsolara:a");
    });

    it("is pure: calling it does NOT log or stage anything", async () => {
      const mod = await freshModule();
      const before = mod.pendingProtocol();
      mod.parseProtocolPayload("?proto=web%2Bvhsolara%3Asomething");
      expect(mod.pendingProtocol()).toBe(before);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("isPlausiblePayload", () => {
    it("accepts the canonical scheme prefix", async () => {
      const { isPlausiblePayload } = await freshModule();
      expect(isPlausiblePayload("web+vhsolara:session/abc")).toBe(true);
      expect(isPlausiblePayload("web+vhsolara:")).toBe(true);
    });

    it("rejects payloads with a different scheme", async () => {
      const { isPlausiblePayload } = await freshModule();
      expect(isPlausiblePayload("javascript:alert(1)")).toBe(false);
      expect(isPlausiblePayload("https://evil.example/")).toBe(false);
      expect(isPlausiblePayload("web vhsolara:session/abc")).toBe(false);
    });
  });

  describe("initProtocolHandler — stages but does NOT act", () => {
    it("stages the payload when proto= is present", async () => {
      const mod = await freshModule();
      mod.initProtocolHandler("?proto=web%2Bvhsolara%3Asession%2Fxyz");
      expect(mod.pendingProtocol()).toBe("web+vhsolara:session/xyz");
    });

    it("does NOT auto-act on the staged payload", async () => {
      const mod = await freshModule();
      mod.initProtocolHandler("?proto=web%2Bvhsolara%3Asession%2Fxyz");
      // The only "act" path is confirmProtocol(): staging alone must not log.
      expect(logSpy).not.toHaveBeenCalled();
      expect(mod.pendingProtocol()).not.toBeNull();
    });

    it("leaves pendingProtocol null when there is no payload", async () => {
      const mod = await freshModule();
      mod.initProtocolHandler("?dir=%2Fwork");
      expect(mod.pendingProtocol()).toBeNull();
    });

    it("does not overwrite an already-staged payload on a second call", async () => {
      const mod = await freshModule();
      mod.initProtocolHandler("?proto=web%2Bvhsolara%3Afirst");
      mod.initProtocolHandler("?proto=web%2Bvhsolara%3Asecond");
      expect(mod.pendingProtocol()).toBe("web+vhsolara:first");
    });
  });

  describe("confirmProtocol / dismissProtocol", () => {
    it("confirmProtocol logs the payload and clears the signal (only act path)", async () => {
      const mod = await freshModule();
      mod.initProtocolHandler("?proto=web%2Bvhsolara%3Asession%2Fgo");
      mod.confirmProtocol();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][1]).toBe("web+vhsolara:session/go");
      expect(mod.pendingProtocol()).toBeNull();
    });

    it("confirmProtocol is a no-op when nothing is staged", async () => {
      const mod = await freshModule();
      mod.confirmProtocol();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("dismissProtocol clears the signal without acting", async () => {
      const mod = await freshModule();
      mod.initProtocolHandler("?proto=web%2Bvhsolara%3Asession%2Fnope");
      mod.dismissProtocol();
      expect(logSpy).not.toHaveBeenCalled();
      expect(mod.pendingProtocol()).toBeNull();
    });
  });
});
