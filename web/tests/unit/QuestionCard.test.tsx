// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// Mock renderMarkdown (the SETTLED-CONTENT markdown path) so the Md component
// resolves without a fetch round-trip. Goldmark wraps lone text in <p>…</p>;
// QuestionCard strips that single wrapping <p> for inline option labels so it
// stays valid phrasing content inside a <button>.
vi.mock("../../src/render", () => ({
  renderMarkdown: (text: string) => Promise.resolve(`<p>${text}</p>`),
}));

// Mock respondQuestion so submit() does not POST. Capture calls to assert the
// answers[][] payload.
const respondQuestion = vi.fn(() => Promise.resolve());
vi.mock("../../src/sync", () => ({
  respondQuestion: (...args: unknown[]) => respondQuestion(...args),
}));

import QuestionCard from "../../src/components/QuestionCard";
import type { Question } from "../../src/types";

const question: Question = {
  id: "q1",
  sessionID: "s1",
  questions: [
    {
      question: "Which approach should I take?",
      options: [{ label: "Refactor" }, { label: "Rewrite" }],
    },
  ],
};

describe("QuestionCard — in-stream card + shared-state popup", () => {
  afterEach(() => {
    cleanup();
    respondQuestion.mockClear();
  });

  it("renders the markdown body and defaults to vertical options", async () => {
    const { container } = render(() => <QuestionCard question={question} />);
    // Markdown resolves asynchronously (createResource); wait for the body.
    await waitFor(() => {
      expect(container.textContent).toContain("Which approach should I take?");
    });
    const opts = container.querySelector(".question-options") as HTMLElement;
    expect(opts).toBeTruthy();
    expect(opts.classList.contains("v")).toBe(true);
    expect(opts.classList.contains("h")).toBe(false);
    // Option key glyphs (A:/B:) and labels survive the markdown rewrite.
    expect(container.querySelectorAll(".question-opt-key").length).toBe(2);
  });

  it("H/V toggle flips the option layout between vertical and horizontal", async () => {
    const { container } = render(() => <QuestionCard question={question} />);
    await waitFor(() =>
      expect(container.textContent).toContain("Which approach"),
    );
    const card = container.querySelector(".question-card") as HTMLElement;
    const toggle = card.querySelector(
      '[aria-label="Toggle option layout"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    const opts = container.querySelector(".question-options") as HTMLElement;
    expect(opts.classList.contains("v")).toBe(true);

    toggle.click();
    expect(opts.classList.contains("h")).toBe(true);
    expect(opts.classList.contains("v")).toBe(false);

    toggle.click();
    expect(opts.classList.contains("v")).toBe(true);
    expect(opts.classList.contains("h")).toBe(false);
  });

  it("popup mirrors the card and selection is SHARED (both directions)", async () => {
    const { container } = render(() => <QuestionCard question={question} />);
    await waitFor(() =>
      expect(container.textContent).toContain("Which approach"),
    );
    const card = container.querySelector(".question-card") as HTMLElement;
    expect(card.querySelectorAll(".question-opt.on")).toHaveLength(0);

    // Open the popup (Portaled to document.body, outside `container`).
    const open = card.querySelector(
      '[aria-label="Open answer in popup"]',
    ) as HTMLButtonElement;
    open.click();
    const pop = await waitFor(
      () => document.querySelector(".card-pop") as HTMLElement,
    );
    expect(pop).toBeTruthy();
    expect(pop.querySelectorAll(".question-opt").length).toBe(2);

    // Pick "Refactor" INSIDE THE POPUP → the INLINE option must reflect the
    // SAME selection. This is the shared-signal guarantee: the popup is a
    // second render surface of the same card, not a copied component.
    const popOpt = pop.querySelector(".question-opt") as HTMLButtonElement;
    popOpt.click();
    expect(card.querySelectorAll(".question-opt.on")).toHaveLength(1);

    // And the reverse: pick inline → popup reflects.
    const inlineOpts = card.querySelectorAll(".question-opt");
    (inlineOpts[1] as HTMLButtonElement).click(); // "Rewrite"
    // Single-select (not multiple): picking Rewrite clears Refactor.
    expect(card.querySelectorAll(".question-opt.on")).toHaveLength(1);
    expect(pop.querySelectorAll(".question-opt.on")).toHaveLength(1);

    // Reply becomes enabled and submits with the picked answer.
    const send = card.querySelector(".question-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    send.click();
    await waitFor(() => expect(respondQuestion).toHaveBeenCalled());
    expect(respondQuestion.mock.calls[0][0]).toBe("q1");
  });

  it("ESC closes the popup", async () => {
    const { container } = render(() => <QuestionCard question={question} />);
    await waitFor(() =>
      expect(container.textContent).toContain("Which approach"),
    );
    const card = container.querySelector(".question-card") as HTMLElement;
    (
      card.querySelector(
        '[aria-label="Open answer in popup"]',
      ) as HTMLButtonElement
    ).click();
    await waitFor(() =>
      expect(document.querySelector(".card-pop")).not.toBeNull(),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() =>
      expect(document.querySelector(".card-pop")).toBeNull(),
    );
  });
});
