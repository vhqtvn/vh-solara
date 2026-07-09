import { describe, expect, it } from "vitest";
import { buildProjectLink } from "../../src/projects";

// Pure-logic tests for the project switcher's "Copy link" URL builder. No DOM:
// the inputs are a base (origin+pathname, no query/hash) and a project
// directory; the output is the shareable deep link. Covers special-character
// encoding (the whole point — a raw `&`/`#`/space in a path MUST be escaped so
// it can't break the query), an empty dir, a base with/without a trailing
// slash, and that the result always carries the `?dir=` key.

describe("buildProjectLink", () => {
  it("builds ${base}?dir=<dir> for a plain directory", () => {
    expect(buildProjectLink("https://host.example/app", "/work/alpha")).toBe(
      "https://host.example/app?dir=%2Fwork%2Falpha",
    );
  });

  it("always contains the ?dir= key", () => {
    expect(buildProjectLink("https://h/", "/x")).toContain("?dir=");
  });

  it("percent-encodes spaces in the directory", () => {
    expect(buildProjectLink("https://h/", "/home/me/my project")).toBe(
      "https://h/?dir=%2Fhome%2Fme%2Fmy%20project",
    );
  });

  it("percent-encodes & so it cannot start a second query param", () => {
    // A raw `&` would otherwise read as `?dir=/a&b=`, splitting the value.
    expect(buildProjectLink("https://h/", "/a&b")).toBe("https://h/?dir=%2Fa%26b");
  });

  it("percent-encodes # so it cannot become a URL fragment", () => {
    // A raw `#` would otherwise truncate the dir at the fragment boundary.
    expect(buildProjectLink("https://h/", "/a#b")).toBe("https://h/?dir=%2Fa%23b");
  });

  it("percent-encodes slashes in the directory (encodeURIComponent, not encodeURI)", () => {
    // encodeURIComponent escapes `/`; encodeURI would not. The deep-link reader
    // (urlDir → URLSearchParams.get) decodes it back, so this round-trips.
    expect(buildProjectLink("https://h/", "/work/alpha")).toBe("https://h/?dir=%2Fwork%2Falpha");
  });

  it("handles an empty directory (total function — yields ?dir=)", () => {
    // Callers gate the UI on a non-empty dir, but the helper itself must not
    // throw or drop the key for "".
    expect(buildProjectLink("https://h/app", "")).toBe("https://h/app?dir=");
  });

  it("preserves a trailing slash on the base (origin+pathname form)", () => {
    // ${location.origin}${location.pathname} for the root path is "https://h/".
    expect(buildProjectLink("https://h/", "/work/alpha")).toBe(
      "https://h/?dir=%2Fwork%2Falpha",
    );
  });

  it("does not prepend a slash when the base has none", () => {
    // A pathname-less base keeps its shape; the helper only appends ?dir=.
    expect(buildProjectLink("https://h", "/x")).toBe("https://h?dir=%2Fx");
  });

  it("round-trips through URLSearchParams.get (the reader path)", () => {
    // The reader is sync/store.ts urlDir → new URLSearchParams(location.search).
    // Simulate it to prove the built link decodes back to the original dir,
    // including for tricky characters (space, &, #, /).
    for (const dir of ["/work/alpha", "/home/me/my project", "/a&b", "/a#b", ""]) {
      const link = buildProjectLink("https://h/app", dir);
      const search = new URL(link).searchParams;
      expect(search.get("dir")).toBe(dir);
    }
  });
});
