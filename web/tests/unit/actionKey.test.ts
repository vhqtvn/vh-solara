// Pure contract test for onActionKey (no DOM/jsdom needed): the helper backs
// `role="button" tabindex="0"` affordances (e.g. the tool-row open-file /
// open-subsession spans) so they activate on BOTH Enter and Space — a bare
// onClick leaves them keyboard-inoperable (WCAG 2.1.1). It must preventDefault
// (Space scrolls otherwise), stopPropagation (mirror the onClick so a parent
// control doesn't also fire), and no-op for any other key.
import { describe, expect, it, vi } from "vitest";
import { onActionKey } from "../../src/lib/a11y";

function fakeEvent(key: string) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    preventDefault,
    stopPropagation,
    asEvent: (): KeyboardEvent =>
      ({ key, preventDefault, stopPropagation }) as unknown as KeyboardEvent,
  };
}

describe("onActionKey", () => {
  it.each(["Enter", " ", "Spacebar"])(
    "fires the action for %j and calls preventDefault + stopPropagation once",
    (key) => {
      const handler = vi.fn();
      const fn = onActionKey(handler);
      const fe = fakeEvent(key);

      fn(fe.asEvent());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(fe.preventDefault).toHaveBeenCalledTimes(1);
      expect(fe.stopPropagation).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "a",
    "A",
    "Tab",
    "Escape",
    "ArrowDown",
    "enter", // lowercase — only exact "Enter" activates
    "space", // only exact " " / "Spacebar" activate
  ])(
    "is a no-op for non-activation key %j (handler + preventDefault + stopPropagation untouched)",
    (key) => {
      const handler = vi.fn();
      const fn = onActionKey(handler);
      const fe = fakeEvent(key);

      fn(fe.asEvent());

      expect(handler).not.toHaveBeenCalled();
      expect(fe.preventDefault).not.toHaveBeenCalled();
      expect(fe.stopPropagation).not.toHaveBeenCalled();
    },
  );

  it("returns a function that can be reused across events", () => {
    const handler = vi.fn();
    const fn = onActionKey(handler);

    fn(fakeEvent("Enter").asEvent());
    fn(fakeEvent(" ").asEvent());
    fn(fakeEvent("x").asEvent());
    fn(fakeEvent("Spacebar").asEvent());

    expect(handler).toHaveBeenCalledTimes(3);
  });
});
