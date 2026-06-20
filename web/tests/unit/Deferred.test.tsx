// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { Deferred } from "../../src/components/Deferred";

// Capture the IntersectionObserver callback so a test can fire intersections
// (jsdom has no IntersectionObserver).
let lastCb: IntersectionObserverCallback | null = null;
let disconnected = false;
class MockIO {
  constructor(cb: IntersectionObserverCallback) {
    lastCb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    disconnected = true;
  }
  takeRecords() {
    return [];
  }
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;

function fireIntersect(isIntersecting: boolean) {
  lastCb?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
}

afterEach(() => {
  cleanup();
  lastCb = null;
  disconnected = false;
});

describe("Deferred (occlusion virtualization)", () => {
  it("mounts children immediately when eager", () => {
    const { queryByTestId } = render(() => (
      <Deferred eager>
        <span data-testid="kid">hi</span>
      </Deferred>
    ));
    expect(queryByTestId("kid")).not.toBeNull();
  });

  it("defers children until the row intersects, then keeps them mounted", () => {
    const { queryByTestId } = render(() => (
      <Deferred>
        <span data-testid="kid">hi</span>
      </Deferred>
    ));
    // Off-screen: not mounted (the expensive child is never created).
    expect(queryByTestId("kid")).toBeNull();

    // Scrolls near the viewport → mounts, and the observer is released.
    fireIntersect(true);
    expect(queryByTestId("kid")).not.toBeNull();
    expect(disconnected).toBe(true);

    // Never unmounts, even if it scrolls away again.
    fireIntersect(false);
    expect(queryByTestId("kid")).not.toBeNull();
  });

  it("reserves min-height while pending and drops it once mounted", () => {
    const { container } = render(() => (
      <Deferred minHeight={48}>
        <span data-testid="kid">hi</span>
      </Deferred>
    ));
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.style.minHeight).toBe("48px");
    fireIntersect(true);
    expect(wrap.style.minHeight).toBe("");
  });
});
