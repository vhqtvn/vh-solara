// @vitest-environment jsdom
//
// GitView uncertain-outcome surface (send-net-resilience slice 6, debate-2
// Q3). The daemon's git commit is receipt-less and only self-protecting while
// the index is empty, so an unconfirmed commit (timeout / network / 5xx) must
// NOT be presented as "failed" and must NOT invite a blind retry: the panel
// shows an outcome-unknown banner that WARDS the commit button and points at
// status+log reconciliation. A definitive 4xx stays a definitive error; a
// push-unknown is honest but retry-safe ("up-to-date").
//
// Mocks mirror GitView.discard.test.tsx (sync / git-actions / git) with
// gitCommit/gitPush as vi.fn so outcomes can be pinned per test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

// projectDir is a SIGNAL in the real sync store — mock it the same way so a
// project switch mid-test re-renders exactly like the real app (a plain
// mutable mock would not). __setTestProjectDir is the test's switch handle.
vi.mock("../../src/sync", async () => {
  const { createSignal } = await import("solid-js");
  const [projectDir, __setTestProjectDir] = createSignal("/repo");
  return { projectDir, __setTestProjectDir };
});

vi.mock("../../src/git-actions", () => ({
  gitStatus: vi.fn(async () => ({
    branch: "main",
    files: [{ file: "a.txt", index: "M", worktree: " " }], // staged → commit enabled
  })),
  gitStage: async () => ({ ok: true }),
  gitUnstage: async () => ({ ok: true }),
  gitDiscard: vi.fn(async () => ({ ok: true })),
  gitCommit: vi.fn(),
  gitPush: vi.fn(),
  gitLog: vi.fn(async () => [{ hash: "abc1230000", subject: "previous commit", date: "2026-10-08 12:00:00 +0000" }]),
  isStaged: (f: { index: string }) => f.index !== " " && f.index !== "?",
  isUntracked: (f: { index: string }) => f.index === "?",
}));

vi.mock("../../src/git", () => ({
  fetchVcsInfo: async () => ({}),
  fetchVcsDiff: async () => [],
}));

import * as gitActions from "../../src/git-actions";
import * as syncMod from "../../src/sync";
import GitView, { clearGitUncertain } from "../../src/components/GitView";
import { clearNotifications, notifications } from "../../src/notify";

// Switch the ACTIVE project dir (reactively — the mock's signal write).
const setProjectDir = (dir: string) =>
  (syncMod as unknown as { __setTestProjectDir: (d: string) => void }).__setTestProjectDir(dir);

async function panel(container: HTMLElement) {
  return await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>(".git-commit-btn");
    if (!b) throw new Error("commit button not mounted");
    return b;
  });
}

async function typeMessage(container: HTMLElement, text: string) {
  const ta = container.querySelector<HTMLTextAreaElement>(".git-commit-msg");
  if (!ta) throw new Error("commit textarea not mounted");
  await fireEvent.input(ta, { target: { value: text } });
}

// Shared read-mock defaults (re-pinned every test in beforeEach): failure
// tests below override gitStatus/gitLog with mockResolvedValue(...), which
// PERSISTS (afterEach clearAllMocks clears calls, not implementations) —
// without re-pinning, a failure pinned in one test would leak into later
// tests that rely on the module-factory defaults.
const STATUS_OK = { branch: "main", files: [{ file: "a.txt", index: "M", worktree: " " }] };
const LOG_OK = [{ hash: "abc1230000", subject: "previous commit", date: "2026-10-08 12:00:00 +0000" }];

beforeEach(() => {
  clearNotifications();
  clearGitUncertain();
  setProjectDir("/repo");
  vi.mocked(gitActions.gitStatus).mockResolvedValue(STATUS_OK);
  vi.mocked(gitActions.gitLog).mockResolvedValue(LOG_OK);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("GitView — uncertain commit outcome (the crux)", () => {
  it("uncertain commit: banner with honest guidance, commit button WARDED, message retained, notification pushed", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "commit: no confirmation within 45s" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "uncertain message");

    await fireEvent.click(btn);

    await waitFor(() => {
      expect(container.querySelector(".git-uncertain")).not.toBeNull();
    });
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).toContain("Commit outcome unknown");
    expect(banner.textContent).toContain("may have landed");
    expect(banner.textContent).toContain("duplicate");
    // Reconciliation surface: the recent-commits log is fetched + rendered.
    expect(gitActions.gitLog).toHaveBeenCalled();
    expect(banner.textContent).toContain("previous commit");
    // The commit button is WARDED (blind retry prohibited)…
    const warded = container.querySelector<HTMLButtonElement>(".git-commit-btn")!;
    expect(warded.disabled).toBe(true);
    // …and the drafted message is RETAINED (only a definitive ok clears it).
    expect(container.querySelector<HTMLTextAreaElement>(".git-commit-msg")!.value).toBe("uncertain message");
    // The notification carries the same honesty (never a "failed" claim).
    const n = notifications.items.find((x) => x.title === "Commit outcome unknown");
    expect(n).toBeDefined();
    expect(n!.detail).toContain("may have landed");
    expect(n!.detail).toContain("duplicate");
    expect(n!.title + n!.detail).not.toContain("failed");
  });

  it("reconcile: Refresh status & log refetches, clears the ward", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "HTTP 502: boom" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "reconcile me");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());
    const statusCalls = vi.mocked(gitActions.gitStatus).mock.calls.length;
    const logCalls = vi.mocked(gitActions.gitLog).mock.calls.length;

    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);

    await waitFor(() => expect(container.querySelector(".git-uncertain")).toBeNull());
    expect(vi.mocked(gitActions.gitLog).mock.calls.length).toBeGreaterThan(logCalls);
    // A fresh status read is part of reconciliation (the initial resource
    // load + the act() reload already called it; the reconcile adds more).
    expect(vi.mocked(gitActions.gitStatus).mock.calls.length).toBeGreaterThan(statusCalls);
    // The ward lifts with the banner.
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(false);
  });
});

// Reconciliation-failure contract (review tier1_b-F1/F2, one root cause with
// tier1_d-F1): the ward lifts ONLY on a SUCCESSFUL status+log reconcile.
// gitStatus/gitLog resolve null on a failed read — a failed read is NOT
// reconciliation. On a still-broken link the banner + ward STAY with an
// honest "could not refresh — unreadable" state, and a FAILED log read must
// never render the did-NOT-land wording (that claim is only honest for a
// successful read of an empty log).
describe("GitView — reconcile failure (a failed read is NOT reconciliation)", () => {
  it("both reads fail: banner + ward RETAINED, honest could-not-refresh state, no did-NOT-land claim — then a successful reconcile lifts the ward", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "commit: no confirmation within 45s" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "dup risk");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());

    // The link is STILL broken: both reconciliation reads fail (null).
    vi.mocked(gitActions.gitStatus).mockResolvedValue(null);
    vi.mocked(gitActions.gitLog).mockResolvedValue(null);
    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);

    // Banner STAYS with an honest unreadable state — never a silent lift.
    await waitFor(() => expect(container.querySelector(".git-uncertain-refresh-failed")).not.toBeNull());
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).toContain("Could not refresh");
    expect(banner.textContent).toContain("unreadable");
    // The failed log read must NOT fabricate the did-NOT-land claim (tier1_d-F1).
    expect(banner.textContent).not.toContain("did NOT land");
    // NOTE: no commit-button assertion in THIS phase — the failed status read
    // also empties the staging resource, which unmounts the button entirely
    // (pre-existing files-gate fallback, out of scope). The ward's retention
    // WITH the button mounted is proven by the status-only and log-only
    // failure tests below; here the banner + could-not-refresh state is the
    // observable.

    // Recovery: both reads succeed again → the ward lifts (the only exit).
    vi.mocked(gitActions.gitStatus).mockResolvedValue(STATUS_OK);
    vi.mocked(gitActions.gitLog).mockResolvedValue(LOG_OK);
    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).toBeNull());
    // The staging panel remounts (files gate reopens) with the staged file +
    // retained message → enabled ⟺ ward lifted.
    await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>(".git-commit-btn");
      expect(b).not.toBeNull();
      expect(b!.disabled).toBe(false);
    });
  });

  it("status read fails (log succeeds): ward RETAINED despite staged files + a drafted message — the disabled button is the WARD, not the empty-files fallback", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "HTTP 502: boom" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "still warded");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());

    // Only reconcile's VERIFICATION read fails (the first gitStatus call after
    // this pin); the resource refetch inside the same reconcile still succeeds,
    // so staged files + the drafted message render and the disabled state can
    // only be the ward.
    vi.mocked(gitActions.gitStatus).mockResolvedValueOnce(null);
    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);

    await waitFor(() => expect(container.querySelector(".git-uncertain-refresh-failed")).not.toBeNull());
    expect(container.querySelector(".git-uncertain")).not.toBeNull();
    expect(container.querySelector(".git-stage-row")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".git-commit-msg")!.value).toBe("still warded");
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(true);
  });

  it("log read fails (status succeeds): ward RETAINED + the log section shows the unreadable state, never the did-NOT-land claim", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "commit: no confirmation within 45s" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "log unreadable");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());

    vi.mocked(gitActions.gitLog).mockResolvedValue(null);
    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);

    // Wait for the reconcile to fully settle (refresh-failed is the LAST
    // signal reconcile writes — once it renders, the log row + staging
    // surface from the same reconcile have flushed too).
    await waitFor(() => {
      expect(container.querySelector(".git-uncertain-refresh-failed")).not.toBeNull();
      const row = container.querySelector(".git-uncertain-log-row.git-uncertain-empty");
      expect(row).not.toBeNull();
      expect(row!.textContent).toContain("unreadable");
    });
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).not.toContain("did NOT land");
    // Status read succeeded (staged file + message present) — the disabled
    // commit button is therefore the WARD, retained on the failed log read.
    expect(container.querySelector(".git-stage-row")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(true);
  });

  // Gate round 4 (tier1_b:F1, ELEMENT level — the discriminator theme's LAST
  // layer): a 200 status read whose files array carries a MALFORMED ELEMENT
  // (container shape fine) must feed reconcile as UNREADABLE. This pin runs
  // the REAL gitStatus discriminator (mockImplementation of the module's
  // vi.fn) against a stubbed 200 fetch, so it proves the element GATE — not
  // merely a null mock — drives the ward decision.
  it("status 200 with a malformed files ELEMENT (healthy log): ward RETAINED — the element gate feeds the reconcile decision", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "commit: no confirmation within 45s" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "element junk");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());

    // Swap in the REAL gitStatus reading a schema-malformed-ELEMENT 200:
    // container shape (branch + files array) is healthy, one element is {}.
    const real = await vi.importActual<typeof import("../../src/git-actions")>("../../src/git-actions");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ branch: "main", files: [{ file: "a.txt", index: "M", worktree: " " }, {}] }),
        })),
    );
    vi.mocked(gitActions.gitStatus).mockImplementation(real.gitStatus);

    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);

    // The element gate read the body as unreadable → NOT a reconciliation:
    // banner + honest could-not-refresh state RETAINED (ward intact).
    await waitFor(() => expect(container.querySelector(".git-uncertain-refresh-failed")).not.toBeNull());
    expect(container.querySelector(".git-uncertain")).not.toBeNull();
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).toContain("Could not refresh — status unreadable");
    // (Button-ward assertion intentionally mirrors the both-reads-fail NOTE
    // above: the null status read empties the staging resource and unmounts
    // the commit button entirely — the retained banner + failed-reconcile
    // state is the ward's observable here.)
  });
});

// tier1_d-F1 pinned from both sides: the did-NOT-land wording is honest ONLY
// for a successful read of an empty log; a failed read shows unreadable.
describe("GitView — log-read honesty on the banner", () => {
  it("HEALTHY empty log (unborn repo): the did-NOT-land wording is shown (existing honest shape)", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "commit: no confirmation within 45s" });
    vi.mocked(gitActions.gitLog).mockResolvedValue([]); // successful read, zero commits
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "fresh repo");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).toContain("did NOT land");
    expect(banner.textContent).not.toContain("unreadable");
  });

  it("FAILED initial log read (broken link at uncertain time): unreadable state, never the did-NOT-land claim", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "commit: no confirmation within 45s" });
    vi.mocked(gitActions.gitLog).mockResolvedValue(null);
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "broken link");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).toContain("log unreadable");
    expect(banner.textContent).not.toContain("did NOT land");
  });
});

describe("GitView — definitive outcomes", () => {
  it("ok commit: message cleared, no banner (pre-guard success shape)", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "ok", output: "[main abc] uncertain-free" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "good message");
    await fireEvent.click(btn);
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".git-commit-msg")!.value).toBe("");
    });
    expect(container.querySelector(".git-uncertain")).toBeNull();
  });

  it("error commit (definitive 4xx): error notification, message retained, no uncertain banner", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "error", error: "commit message required" });
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "will be rejected");
    await fireEvent.click(btn);
    await waitFor(() => {
      expect(notifications.items.some((x) => x.kind === "error" && x.detail?.includes("commit message required"))).toBe(true);
    });
    expect(container.querySelector(".git-uncertain")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".git-commit-msg")!.value).toBe("will be rejected");
  });
});

describe("GitView — uncertain push outcome (benign retry)", () => {
  it("uncertain push: honest banner with retry-SAFE wording, log rendered, commit button not ward-blocked by a push unknown", async () => {
    vi.mocked(gitActions.gitPush).mockResolvedValue({ outcome: "uncertain", detail: "push: no confirmation within 630s" });
    const { container } = render(() => <GitView />);
    await panel(container);
    // A drafted commit makes the commit-button enabled-state meaningful:
    // a PUSH unknown (retry-benign) must NOT ward the commit gesture.
    await typeMessage(container, "next commit");
    const pushBtn = await waitFor(() => {
      const b = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((x) => x.textContent === "Push");
      if (!b) throw new Error("push button not mounted");
      return b;
    });
    await fireEvent.click(pushBtn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).toContain("Push outcome unknown");
    expect(banner.textContent).toContain("safe");
    expect(banner.textContent).toContain("previous commit");
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(false);
  });
});

describe("GitView — visible running state", () => {
  it("commit in flight: button label swaps to Committing…, then restores", async () => {
    let release!: (v: { outcome: "ok"; output?: string }) => void;
    vi.mocked(gitActions.gitCommit).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "slow commit");
    await fireEvent.click(btn);
    await waitFor(() => {
      expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.textContent).toContain("Committing");
    });
    release({ outcome: "ok", output: "done" });
    await waitFor(() => {
      expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.textContent).toContain("Commit (");
    });
  });

  it("push in flight: button label swaps to Pushing…", async () => {
    let release!: (v: { outcome: "ok" }) => void;
    vi.mocked(gitActions.gitPush).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { container } = render(() => <GitView />);
    await panel(container);
    const pushBtn = await waitFor(() => {
      const b = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((x) => x.textContent === "Push");
      if (!b) throw new Error("push button not mounted");
      return b;
    });
    await fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some((x) => x.textContent === "Pushing…")).toBe(true);
    });
    release({ outcome: "ok" });
    await waitFor(() => {
      expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some((x) => x.textContent === "Push")).toBe(true);
    });
  });
});

// Per-repo uncertain state (gate review slice-6 BLOCK findings, two root
// causes). A-F1/A-F2: a single-module uncertain slot let a push-uncertain
// OVERWRITE an active commit-uncertain on the same repo → commitWarded()
// flipped false → the commit button re-enabled with staged files + a retained
// message: one click from a duplicate commit. B-F1/B-F2: the uncertain result
// was tagged with projectDir() read AFTER the await, so a project switch
// mid-flight warded the WRONG repo (the switched-to one) and left the
// originating repo unwarded. The contract under test: the ward is per-repo,
// keyed by the request's START-time dir; within one repo a commit ward is
// never weakened by anything but a successful status+log reconcile.
describe("GitView — per-repo uncertain state (A-F1/A-F2 + B-F1/B-F2)", () => {
  it("push-uncertain over an ACTIVE commit-uncertain (same repo): commit ward persists — banner stays the commit banner, button stays warded, reconcile is still the only exit", async () => {
    vi.mocked(gitActions.gitCommit).mockResolvedValue({ outcome: "uncertain", detail: "commit: no confirmation within 45s" });
    // Deferred push so the test controls WHEN the push outcome settles (the
    // settle gate is the running label, not notifications — pushNotification
    // de-dupes within a 4s window that survives across tests).
    let releasePush!: (v: { outcome: "uncertain"; detail: string }) => void;
    vi.mocked(gitActions.gitPush).mockImplementation(
      () => new Promise((resolve) => { releasePush = resolve; }),
    );
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "dup risk");
    await fireEvent.click(btn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());

    // A push is retry-safe and never warded, so the gesture is AVAILABLE while
    // a commit-uncertain is active — and going uncertain must not touch the
    // commit ward (the old single-slot signal replaced it wholesale).
    const pushBtn = await waitFor(() => {
      const b = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((x) => x.textContent === "Push");
      if (!b) throw new Error("push button not mounted");
      return b;
    });
    await fireEvent.click(pushBtn);
    // Settle gate: the push runs ("Pushing…"), then fully resolves (label
    // restores) — after this the push-uncertain outcome has been written.
    await waitFor(() => {
      expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some((x) => x.textContent === "Pushing…")).toBe(true);
    });
    releasePush({ outcome: "uncertain", detail: "push: no confirmation within 630s" });
    await waitFor(() => {
      expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some((x) => x.textContent === "Push")).toBe(true);
    });

    // The commit ward SURVIVED: the banner is still the COMMIT banner (the
    // stronger state — the push honesty rode its notification instead)…
    await waitFor(() => {
      const banner = container.querySelector(".git-uncertain");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("Commit outcome unknown");
    });
    // …and the commit button is STILL warded with staged files + the retained
    // message in place (one click from a duplicate commit, otherwise).
    expect(container.querySelector<HTMLTextAreaElement>(".git-commit-msg")!.value).toBe("dup risk");
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(true);

    // Reconciliation remains the ONLY exit: a successful status+log reconcile
    // lifts banner + ward together.
    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).toBeNull());
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(false);
  });

  it("project switch mid-flight: the ward lands on the START-time repo (A); repo B shows nothing and is unwarded; switching back to A shows the ward", async () => {
    // Deferred commit — resolve AFTER the project switch (the POST ran against
    // repo A; the outcome arrives while the operator looks at repo B).
    let releaseCommit!: (v: { outcome: "uncertain"; detail: string }) => void;
    vi.mocked(gitActions.gitCommit).mockImplementation(
      () => new Promise((resolve) => { releaseCommit = resolve; }),
    );
    setProjectDir("/repo/a");
    const { container } = render(() => <GitView />);
    const btn = await panel(container);
    await typeMessage(container, "mid-flight switch");
    await fireEvent.click(btn);

    // Mid-flight: switch to repo B, THEN let the commit outcome resolve.
    setProjectDir("/repo/b");
    releaseCommit({ outcome: "uncertain", detail: "HTTP 504: link lost" });
    // Settle gate: "Committing…" restores to "Commit (…)" — the uncertain
    // outcome has been written and runMutation's finally has run.
    await waitFor(() => {
      expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.textContent).toContain("Commit (");
    });
    // Repo B's panel is up with staged files + the drafted message…
    expect(container.querySelector(".git-stage-row")).not.toBeNull();
    // …but B carries NO banner and NO ward — the uncertainty belongs to A
    // (the request's START-time dir, not the dir read after the await).
    expect(container.querySelector(".git-uncertain")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(false);

    // Switch back to A: the ward is there, binding A's staged files + message.
    setProjectDir("/repo/a");
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());
    const banner = container.querySelector(".git-uncertain")!;
    expect(banner.textContent).toContain("Commit outcome unknown");
    expect(container.querySelector<HTMLTextAreaElement>(".git-commit-msg")!.value).toBe("mid-flight switch");
    expect(container.querySelector<HTMLButtonElement>(".git-commit-btn")!.disabled).toBe(true);
  });

  it("A-F4 fold: a FRESH uncertain state clears the stale failed-reconcile line (push-uncertain → failed reconcile → push again)", async () => {
    vi.mocked(gitActions.gitPush).mockResolvedValue({ outcome: "uncertain", detail: "push: no confirmation within 630s" });
    const { container } = render(() => <GitView />);
    await panel(container);
    const pushBtn = await waitFor(() => {
      const b = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((x) => x.textContent === "Push");
      if (!b) throw new Error("push button not mounted");
      return b;
    });
    await fireEvent.click(pushBtn);
    await waitFor(() => expect(container.querySelector(".git-uncertain")).not.toBeNull());

    // The reconcile fails (status read) → the honest could-not-refresh line.
    vi.mocked(gitActions.gitStatus).mockResolvedValueOnce(null);
    await fireEvent.click(container.querySelector<HTMLButtonElement>(".git-uncertain .git-mini")!);
    await waitFor(() => expect(container.querySelector(".git-uncertain-refresh-failed")).not.toBeNull());

    // Push again → uncertain again (push-over-push: a FRESH banner state) —
    // the stale failed-reconcile line must not survive onto the new banner.
    // (Gate on the second gitPush CALL; its mockResolvedValue outcome lands a
    // microtask later, which the waitFor below absorbs.)
    await fireEvent.click(pushBtn);
    expect(vi.mocked(gitActions.gitPush).mock.calls.length).toBe(2);
    await waitFor(() => expect(container.querySelector(".git-uncertain-refresh-failed")).toBeNull());
    expect(container.querySelector(".git-uncertain")).not.toBeNull();
  });
});
