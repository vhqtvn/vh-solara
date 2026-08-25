// @vitest-environment jsdom
//
// Characterization tests for the tool-rendering helpers extracted from
// components/Part.tsx (TS refactor slice 2). These lock the new
// components/ToolPart.tsx seam by asserting the EXACT current behavior of the
// pure helpers ToolPart consumes: the tool-output → markdown-fence classifiers
// (jsonPretty / looksXML, which drive ToolBody's fence-vs-plain decision) and
// the tool-name → Icon-glyph mapping (toolIconName, which drives the head icon).
//
// The component behavior (ToolBody / ToolPart) is already characterized through
// the PartView dispatcher by PartTool.test.tsx (live duration) and
// PartToolAction.test.tsx (open-file keyboard action); this file covers the
// three pure helpers that had NO direct coverage inside Part.tsx.
//
// Behavior-preserving extraction: these tests pin what the functions already did
// inside Part.tsx so a future refactor of the seam cannot silently shift it.
//
// jsdom doesn't implement matchMedia, but importing ToolPart pulls in
// ./Part → code/frame → layout, which calls window.matchMedia at module load
// (the same chain PartTool.test.tsx stubs). Import the shared stub BEFORE the
// component import is evaluated — see _matchMedia.ts.
import "./_matchMedia";
import { describe, expect, it } from "vitest";
import { editDiffLines, jsonPretty, looksXML, toolIconName } from "../../src/components/ToolPart";

// ---- jsonPretty ----------------------------------------------------------
// Detects object/array-shaped strings and returns 2-space pretty JSON so ToolBody
// can fence them as ```json for server-side syntax highlighting. Returns null for
// anything that isn't a JSON object/array (scalars, malformed JSON, other text)
// so ToolBody falls through to the plain <pre> path.
describe("jsonPretty", () => {
  it("pretty-prints a flat object with 2-space indent", () => {
    expect(jsonPretty('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("pretty-prints an array", () => {
    expect(jsonPretty("[1,2,3]")).toBe("[\n  1,\n  2,\n  3\n]");
  });

  it("indents nested structures", () => {
    expect(jsonPretty('{"a":{"b":2}}')).toBe('{\n  "a": {\n    "b": 2\n  }\n}');
  });

  it("trims surrounding whitespace before parsing", () => {
    // Tool output often has leading/trailing whitespace; the classifier trims so
    // a padded JSON blob is still recognized and fenced.
    expect(jsonPretty('  {"a":1}\n')).toBe('{\n  "a": 1\n}');
  });

  it("returns the compact form for an empty object", () => {
    expect(jsonPretty("{}")).toBe("{}");
  });

  it("returns the compact form for an empty array", () => {
    expect(jsonPretty("[]")).toBe("[]");
  });

  it("re-normalizes key order / spacing of already-printed JSON", () => {
    // JSON.parse drops the original formatting; stringify re-emits canonical
    // 2-space form regardless of input spacing.
    expect(jsonPretty('{  "a" : 1 }')).toBe('{\n  "a": 1\n}');
  });

  it("returns null for a JSON scalar that is not an object/array (no { or [ prefix)", () => {
    // The {/[ prefix gate means bare strings/numbers aren't fenced as JSON even
    // though they're valid JSON — ToolBody shows them as plain text.
    expect(jsonPretty('"just a string"')).toBeNull();
    expect(jsonPretty("42")).toBeNull();
    expect(jsonPretty("true")).toBeNull();
    expect(jsonPretty("null")).toBeNull();
  });

  it("returns null for non-JSON text", () => {
    expect(jsonPretty("not json at all")).toBeNull();
  });

  it("returns null for malformed JSON that starts with { or [ but fails to parse", () => {
    expect(jsonPretty("{not closed")).toBeNull();
    expect(jsonPretty("[1,2,")).toBeNull();
    expect(jsonPretty("{,}")).toBeNull();
  });
});

// ---- looksXML ------------------------------------------------------------
// Detects XML-shaped tool output so ToolBody can fence it as ```xml. Requires a
// tag-like opening (< + letter/?/!) AND a closing tag at the end; both gates
// must pass so plain text or fragments don't get mis-fenced.
describe("looksXML", () => {
  it("recognizes a simple element with a closing tag", () => {
    expect(looksXML("<foo>bar</foo>")).toBe(true);
  });

  it("trims surrounding whitespace before testing", () => {
    expect(looksXML("  <foo>bar</foo>\n")).toBe(true);
  });

  it("recognizes an XML declaration followed by a root element", () => {
    // The opening gate allows <? (the `?` in the char class) for <?xml ...?>.
    expect(looksXML('<?xml version="1.0"?><root></root>')).toBe(true);
  });

  it("recognizes a DOCTYPE + html document", () => {
    // The opening gate allows <! (the `!` in the char class) for <!DOCTYPE>.
    expect(looksXML("<!DOCTYPE html><html></html>")).toBe(true);
  });

  it("recognizes hyphenated tag names in the closing tag", () => {
    expect(looksXML("<a-b>x</a-b>")).toBe(true);
  });

  it("recognizes namespaced (colon) tag names in the closing tag", () => {
    expect(looksXML("<a:b>x</a:b>")).toBe(true);
  });

  it("returns false for plain text (no tag opener)", () => {
    expect(looksXML("not xml")).toBe(false);
  });

  it("returns false for an opener with no closing tag", () => {
    expect(looksXML("<only-open>")).toBe(false);
  });

  it("returns false when leading text precedes the first tag", () => {
    expect(looksXML("text <foo>bar</foo>")).toBe(false);
  });

  it("returns false when trailing text follows the closing tag", () => {
    // The closing-tag anchor requires \\s*$ — trailing non-whitespace fails it.
    expect(looksXML("<foo>bar</foo> tail")).toBe(false);
  });

  it("returns false when the opener's first char is a digit (not a tag name)", () => {
    expect(looksXML("<123>")).toBe(false);
  });
});

// ---- toolIconName --------------------------------------------------------
// Maps a tool name to one of the Icon glyphs (see Icon.tsx). Case-insensitive
// substring match, first branch wins. Pins the full mapping incl. the ordering
// (e.g. a tool name containing both "write" and "todo" takes the edit/write
// branch, not the todo branch) so a future reorder can't silently shift icons.
describe("toolIconName", () => {
  it("maps edit/write/patch/create/str_replace tools to 'edit'", () => {
    expect(toolIconName("edit")).toBe("edit");
    expect(toolIconName("write")).toBe("edit");
    expect(toolIconName("str_replace")).toBe("edit");
    expect(toolIconName("create_file")).toBe("edit");
  });

  it("maps bash/shell/cmd/terminal tools to 'terminal'", () => {
    expect(toolIconName("bash")).toBe("terminal");
    expect(toolIconName("execute_bash")).toBe("terminal");
  });

  it("maps read/view/cat tools to 'eye'", () => {
    expect(toolIconName("read")).toBe("eye");
    expect(toolIconName("view")).toBe("eye");
  });

  it("maps grep/search/find/glob/ripgrep tools to 'filter'", () => {
    expect(toolIconName("grep")).toBe("filter");
    expect(toolIconName("glob")).toBe("filter");
    expect(toolIconName("ripgrep")).toBe("filter");
  });

  it("maps list/ls/dir tools to 'menu'", () => {
    expect(toolIconName("list")).toBe("menu");
    expect(toolIconName("ls")).toBe("menu");
  });

  it("maps fetch/curl/wget/web tools to 'send'", () => {
    expect(toolIconName("fetch")).toBe("send");
    expect(toolIconName("webfetch")).toBe("send");
    expect(toolIconName("curl")).toBe("send");
  });

  it("maps task/agent tools to 'fork'", () => {
    expect(toolIconName("task")).toBe("fork");
    expect(toolIconName("agent")).toBe("fork");
  });

  it("maps a bare todo tool to 'check'", () => {
    // A name that is ONLY "todo" (no write/list/edit keyword) reaches the todo
    // branch. "todowrite" does NOT — see the ordering-collisions test below.
    expect(toolIconName("todo")).toBe("check");
  });

  it("maps a question tool to 'help'", () => {
    expect(toolIconName("question")).toBe("help");
  });

  it("maps a skill tool to 'info'", () => {
    expect(toolIconName("skill")).toBe("info");
  });

  it("does NOT map 'lsp' to info — the earlier 'ls' substring wins 'menu'", () => {
    // Characterization quirk: "lsp" contains "ls", which the list|ls|dir branch
    // (checked earlier) catches before the lsp|skill branch is ever reached. Pin
    // this so a future branch reorder surfaces as a visible diff.
    expect(toolIconName("lsp")).toBe("menu");
  });

  it("matches case-insensitively", () => {
    expect(toolIconName("BASH")).toBe("terminal");
    expect(toolIconName("Write")).toBe("edit");
    expect(toolIconName("WebFetch")).toBe("send");
  });

  it("returns 'layers' (the default) for an unrecognized tool", () => {
    expect(toolIconName("some_unknown_tool")).toBe("layers");
  });

  it("returns 'layers' (the default) for an empty string", () => {
    expect(toolIconName("")).toBe("layers");
  });

  it("resolves ordering collisions by the first matching branch", () => {
    // "str_replace_editor" matches BOTH the edit/write branch (str_replace, edit)
    // and would match nothing later — confirms the edit branch wins early.
    expect(toolIconName("str_replace_editor")).toBe("edit");
    // A name containing both a write and a todo keyword takes edit (earlier
    // branch), NOT check — pins the branch ordering.
    expect(toolIconName("todo_writer")).toBe("edit");
  });
});

// ---- editDiffLines --------------------------------------------------------
// Builds the edit/write contents preview (oldString → del lines, newString /
// write content → add lines) rendered inside a tool row's disclosure body.
// Shape-driven: an input carrying the edit fields renders, anything else
// returns null so non-edit tools keep their current body untouched. These pin
// the exact line/kind/output so a refactor can't silently shift the preview.
describe("editDiffLines", () => {
  it("returns null for null/undefined input", () => {
    expect(editDiffLines(null)).toBeNull();
    expect(editDiffLines(undefined)).toBeNull();
  });

  it("returns null for an empty input object", () => {
    expect(editDiffLines({})).toBeNull();
  });

  it("returns null for non-edit input (read/bash shapes carry none of the fields)", () => {
    expect(editDiffLines({ filePath: "src/parser.go" })).toBeNull();
    expect(editDiffLines({ command: "go test ./..." })).toBeNull();
    expect(editDiffLines({ filePath: "a.go", pattern: "foo" })).toBeNull();
  });

  it("returns null when the edit fields are present but not strings", () => {
    expect(editDiffLines({ oldString: 1, newString: null, content: true })).toBeNull();
  });

  it("renders del lines for oldString then add lines for newString, in order", () => {
    const out = editDiffLines({ filePath: "parser.go", oldString: "a\nb", newString: "x" });
    expect(out).toEqual([
      { kind: "del", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
    ]);
  });

  it("drops ONE trailing blank line when a block ends with a newline", () => {
    // A byte-exact trailing "\n" renders as a noise blank; interior blanks stay.
    const out = editDiffLines({ oldString: "a\n\nb\n", newString: "c\n" });
    expect(out).toEqual([
      { kind: "del", text: "a" },
      { kind: "del", text: "" },
      { kind: "del", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("keeps an entirely empty oldString as zero del lines (insert)", () => {
    const out = editDiffLines({ oldString: "", newString: "new line" });
    expect(out).toEqual([{ kind: "add", text: "new line" }]);
  });

  it("keeps an entirely empty newString as zero add lines (delete)", () => {
    const out = editDiffLines({ oldString: "gone", newString: "" });
    expect(out).toEqual([{ kind: "del", text: "gone" }]);
  });

  it("renders a write's content as all add lines", () => {
    const out = editDiffLines({ filePath: "new.go", content: "package main\n\nfunc f() {}" });
    expect(out).toEqual([
      { kind: "add", text: "package main" },
      { kind: "add", text: "" },
      { kind: "add", text: "func f() {}" },
    ]);
  });

  it("prefers oldString/newString over content when both are present", () => {
    // Edit inputs never carry `content`; if some tool sent both, the edit pair
    // is the truth and content must NOT be appended.
    const out = editDiffLines({ oldString: "a", newString: "b", content: "c" });
    expect(out).toEqual([
      { kind: "del", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("prepends a 'replaces every match' meta header when replaceAll is true", () => {
    const out = editDiffLines({ oldString: "a", newString: "b", replaceAll: true });
    expect(out).toEqual([
      { kind: "meta", text: "replaces every match" },
      { kind: "del", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("adds no meta header when replaceAll is false or absent", () => {
    expect(editDiffLines({ oldString: "a", newString: "b", replaceAll: false })).toEqual([
      { kind: "del", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(editDiffLines({ oldString: "a", newString: "b" })![0].kind).toBe("del");
  });

  it("truncates each block independently at maxLines with a '… N more lines' note", () => {
    // 35-line oldString, 2-line newString, cap 3: the del block keeps its first
    // 3 lines + a note, and the (small) add block stays fully visible.
    const bigOld = Array.from({ length: 35 }, (_, i) => `old${i}`).join("\n");
    const out = editDiffLines({ oldString: bigOld, newString: "n1\nn2" }, 3);
    expect(out).toEqual([
      { kind: "del", text: "old0" },
      { kind: "del", text: "old1" },
      { kind: "del", text: "old2" },
      { kind: "meta", text: "… 32 more lines" },
      { kind: "add", text: "n1" },
      { kind: "add", text: "n2" },
    ]);
  });

  it("emits one truncation note per oversized block (both blocks capped)", () => {
    const old = Array.from({ length: 5 }, (_, i) => `o${i}`).join("\n");
    const nu = Array.from({ length: 5 }, (_, i) => `n${i}`).join("\n");
    const out = editDiffLines({ oldString: old, newString: nu }, 2);
    expect(out).toEqual([
      { kind: "del", text: "o0" },
      { kind: "del", text: "o1" },
      { kind: "meta", text: "… 3 more lines" },
      { kind: "add", text: "n0" },
      { kind: "add", text: "n1" },
      { kind: "meta", text: "… 3 more lines" },
    ]);
  });

  it("truncates a write's content block like any other", () => {
    const content = Array.from({ length: 4 }, (_, i) => `l${i}`).join("\n");
    const out = editDiffLines({ content }, 2);
    expect(out).toEqual([
      { kind: "add", text: "l0" },
      { kind: "add", text: "l1" },
      { kind: "meta", text: "… 2 more lines" },
    ]);
  });

  it("does not truncate blocks that fit exactly at maxLines", () => {
    const exactly = "a\nb\nc";
    const out = editDiffLines({ oldString: exactly }, 3);
    expect(out).toEqual([
      { kind: "del", text: "a" },
      { kind: "del", text: "b" },
      { kind: "del", text: "c" },
    ]);
  });

  it("returns an empty array (not null) when the fields exist but hold no lines", () => {
    // Shape present, content empty — the component maps [] to "render nothing".
    expect(editDiffLines({ oldString: "", newString: "" })).toEqual([]);
    expect(editDiffLines({ content: "" })).toEqual([]);
  });
});
