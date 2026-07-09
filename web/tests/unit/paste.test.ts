import { describe, expect, it } from "vitest";
import { harvestPastedFiles } from "../../src/lib/paste";

const file = (name: string, type = "image/png") =>
  new File([new Uint8Array([1, 2, 3])], name, { type });

describe("harvestPastedFiles", () => {
  it("harvests a file exposed only via items.getAsFile() when files is empty", () => {
    // This is symptom #2: image paste arrives via items, files stays empty.
    const f = file("shot.png");
    const out = harvestPastedFiles([], [{ kind: "file", getAsFile: () => f }]);
    expect(out).toEqual([f]);
  });

  it("harvests a file exposed only via files when items is empty", () => {
    const f = file("doc.pdf", "application/pdf");
    const out = harvestPastedFiles([f], []);
    expect(out).toEqual([f]);
  });

  it("prefers items and does not double-count when both sources are populated", () => {
    const fromFiles = file("a.png");
    const fromItems = file("b.png");
    const out = harvestPastedFiles([fromFiles], [{ kind: "file", getAsFile: () => fromItems }]);
    expect(out).toEqual([fromItems]);
  });

  it("ignores non-file items (e.g. string/text) and still picks up a later file item", () => {
    const f = file("img.png");
    const out = harvestPastedFiles([], [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => f },
    ]);
    expect(out).toEqual([f]);
  });

  it("returns empty (plain-text paste fallthrough) when neither source has a file", () => {
    expect(harvestPastedFiles([], [{ kind: "string", getAsFile: () => null }])).toEqual([]);
    expect(harvestPastedFiles(null, null)).toEqual([]);
    expect(harvestPastedFiles(undefined, undefined)).toEqual([]);
    expect(harvestPastedFiles([], [])).toEqual([]);
  });
});
