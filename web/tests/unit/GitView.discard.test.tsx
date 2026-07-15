// @vitest-environment jsdom
// P2-WEB-002: GitView's destructive "Discard changes" affordance must use the
// in-app confirm dialog, never window.confirm. Asserts:
//   • window.confirm is NOT invoked when Discard is clicked
//   • the confirm dialog mounts on Discard (role=dialog, aria-label present)
//   • confirming fires gitDiscard([file]) with the row's path
//   • Cancel closes the dialog without firing gitDiscard
//
// Mocks mirror GitView.test.tsx (sync / git-actions / git) but gitStatus
// returns a single unstaged file so a Discard button renders, and gitDiscard is
// a vi.fn so calls can be asserted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const DISCARD_FILE = "unstaged.txt";

vi.mock("../../src/sync", () => ({ projectDir: () => "/repo" }));

vi.mock("../../src/git-actions", () => ({
  gitStatus: async () => ({
    branch: "main",
    files: [{ file: DISCARD_FILE, index: " ", worktree: "M" }], // !staged → row has Discard
  }),
  gitStage: async () => ({ ok: true }),
  gitUnstage: async () => ({ ok: true }),
  gitDiscard: vi.fn(async () => ({ ok: true })),
  gitCommit: async () => ({ ok: true }),
  gitPush: async () => ({ ok: true }),
  isStaged: (f: { index: string }) => f.index !== " " && f.index !== "?",
  isUntracked: (f: { index: string }) => f.index === "?",
}));

vi.mock("../../src/git", () => ({
  fetchVcsInfo: async () => ({}),
  fetchVcsDiff: async () => [],
}));

import * as gitActions from "../../src/git-actions";
import GitView from "../../src/components/GitView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function openDiscardDialog(container: HTMLElement) {
  // The StagingPanel Discard button mounts once the gitStatus resource resolves.
  const discardBtn = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>('button.git-mini[data-tip="Discard changes"]');
    if (!b) throw new Error("discard button not mounted");
    return b;
  });
  await fireEvent.click(discardBtn);
  await waitFor(() => {
    expect(container.querySelector('.dialog.confirm[role="dialog"][aria-label="Confirm discard"]')).not.toBeNull();
  });
}

describe("GitView — discard uses in-app confirm, not window.confirm", () => {
  it("does not call window.confirm and mounts the confirm dialog on Discard", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const { container } = render(() => <GitView />);
    await openDiscardDialog(container);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("confirming fires gitDiscard with the file path", async () => {
    const { container } = render(() => <GitView />);
    await openDiscardDialog(container);

    const go = container.querySelector<HTMLButtonElement>(".confirm-go")!;
    await fireEvent.click(go);

    await waitFor(() => {
      expect(gitActions.gitDiscard).toHaveBeenCalledWith([DISCARD_FILE]);
    });
  });

  it("Cancel closes the dialog without firing gitDiscard", async () => {
    const { container } = render(() => <GitView />);
    await openDiscardDialog(container);

    const cancel = container.querySelector<HTMLButtonElement>(".confirm-cancel")!;
    await fireEvent.click(cancel);

    expect(gitActions.gitDiscard).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(container.querySelector('.dialog.confirm[role="dialog"][aria-label="Confirm discard"]')).toBeNull();
    });
  });
});
