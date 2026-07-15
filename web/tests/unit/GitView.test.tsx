// @vitest-environment jsdom
// Accessibility contract for GitView's icon-only buttons. These buttons carry
// only a glyph (or an <Icon>) as visible content, so without an aria-label a
// screen reader announces nothing useful. The shared Tooltip component renders
// `data-tip` as a SEPARATE role="tooltip" bubble and never associates it back to
// the source element (no aria-describedby), so data-tip alone does NOT give the
// button an accessible name — aria-label is required.
//
// Mocks: GitView reads projectDir() from sync (which would otherwise drag in the
// whole live-session graph at import) and, via StagingPanel, gitStatus() from
// git-actions. We stub sync to a fixed project dir and gitStatus to return one
// STAGED + one UNSTAGED file so the row renders BOTH the Stage button (the
// unstaged file's fallback) and the Unstage button (the staged file). git's two
// vcs fetches are stubbed to empty fallbacks so the test makes no network calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

vi.mock("../../src/sync", () => ({
  projectDir: () => "/repo",
}));

vi.mock("../../src/git-actions", () => ({
  gitStatus: async () => ({
    branch: "main",
    files: [
      { file: "staged.txt", index: "M", worktree: " " }, // isStaged → Unstage + Discard
      { file: "unstaged.txt", index: " ", worktree: "M" }, // !staged → Stage + Discard
    ],
  }),
  gitStage: async () => ({ ok: true }),
  gitUnstage: async () => ({ ok: true }),
  gitDiscard: async () => ({ ok: true }),
  gitCommit: async () => ({ ok: true }),
  gitPush: async () => ({ ok: true }),
  isStaged: (f: { index: string }) => f.index !== " " && f.index !== "?",
  isUntracked: (f: { index: string }) => f.index === "?",
}));

vi.mock("../../src/git", () => ({
  fetchVcsInfo: async () => ({}),
  fetchVcsDiff: async () => [],
}));

import GitView from "../../src/components/GitView";

afterEach(cleanup);

describe("GitView — icon button accessible names", () => {
  it("each icon-only button exposes an aria-label matching its data-tip", async () => {
    const { container } = render(() => <GitView />);

    // The StagingPanel buttons mount only once the gitStatus resource resolves.
    // The Refresh button is always present (not resource-gated).
    await waitFor(() => {
      expect(container.querySelector('button.git-mini[data-tip="Stage"]')).not.toBeNull();
    });

    const stage = container.querySelector<HTMLButtonElement>('button.git-mini[data-tip="Stage"]');
    const unstage = container.querySelector<HTMLButtonElement>('button.git-mini[data-tip="Unstage"]');
    const discards = container.querySelectorAll<HTMLButtonElement>(
      'button.git-mini[data-tip="Discard changes"]',
    );
    const refresh = container.querySelector<HTMLButtonElement>("button.git-refresh");

    // Stage (unstaged file's fallback row button).
    expect(stage, "Stage button should render").not.toBeNull();
    expect(stage!.getAttribute("aria-label")).toBe("Stage");

    // Unstage (staged file's row button).
    expect(unstage, "Unstage button should render").not.toBeNull();
    expect(unstage!.getAttribute("aria-label")).toBe("Unstage");

    // Discard renders once per staging row (2 files → 2 buttons).
    expect(discards.length).toBe(2);
    discards.forEach((b) => expect(b.getAttribute("aria-label")).toBe("Discard changes"));

    // Refresh glyph has no text content; it needs an explicit name.
    expect(refresh, "Refresh button should render").not.toBeNull();
    expect(refresh!.getAttribute("aria-label")).toBe("Refresh");
  });
});
