// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { placeStreamCaret } from "../../src/lib/streamCaret";

function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}
function caret(): HTMLElement {
  const c = document.createElement("span");
  c.className = "stream-caret";
  return c;
}

describe("placeStreamCaret", () => {
  it("trails the text inside the last paragraph (not its own line)", () => {
    const root = render("<p>first</p><p>last line</p>");
    const c = caret();
    placeStreamCaret(root, c);
    // The caret lands INSIDE the last <p>, after its text — not as a sibling of
    // the paragraphs at the .md-stream root.
    expect(c.parentElement?.tagName).toBe("P");
    expect(c.parentElement?.textContent).toBe("last line");
    expect(root.lastElementChild?.lastElementChild).toBe(c);
  });

  it("descends into the last <li> of a trailing list", () => {
    const root = render("<p>intro</p><ul><li>a</li><li>b</li></ul>");
    const c = caret();
    placeStreamCaret(root, c);
    expect(c.parentElement?.tagName).toBe("LI");
    expect(c.parentElement?.textContent).toBe("b");
  });

  it("descends into the <code> of a fenced block", () => {
    const root = render("<pre><code>x = 1</code></pre>");
    const c = caret();
    placeStreamCaret(root, c);
    expect(c.parentElement?.tagName).toBe("CODE");
  });

  it("stops at the parent when the trailing element is void (image)", () => {
    const root = render('<p>see <img src="x"></p>');
    const c = caret();
    placeStreamCaret(root, c);
    // Not appended into the <img> (a void element); sits in the <p> after it.
    expect(c.parentElement?.tagName).toBe("P");
    expect(c.previousElementSibling?.tagName).toBe("IMG");
  });

  it("trails at the root when there is no descendable element", () => {
    const root = render("");
    const c = caret();
    placeStreamCaret(root, c);
    expect(c.parentElement).toBe(root);
  });
});
