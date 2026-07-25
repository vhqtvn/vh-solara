import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { demoDir, projectUrl } from "./util";

// e2e coverage for the composer paste -> attachment wiring, guarding the paste
// fix that lives in web/src/lib/paste.ts (harvestPastedFiles) and
// web/src/components/ChatView.tsx (onPaste / addFiles / flushPendingAttachments).
//
// Two regressions this suite exists to catch:
//   1. "Ctrl+V does nothing" — the pasted file surfaced only via
//      clipboardData.items (kind "file" + getAsFile) while clipboardData.files
//      stayed empty; a handler that read only .files attached nothing.
//      harvestPastedFiles now prefers items; this suite reproduces the
//      files-empty condition to actually exercise that path.
//   2. "Paste into the draft hero navigates away and drops the attachment" —
//      addFiles in draft mode now queues the raw File locally (chip shows from
//      filename) instead of creating a session to upload into; the upload is
//      deferred to send() -> flushPendingAttachments once a session exists.
//
// Test 1 is PARAMETERIZED over the two attachment regimes because addFiles
// branches on the selected model's vision capability (see ChatView.addFiles and
// lib/inlineAttach.ts effectiveInline):
//
//   NON-VISION (fixture model "dummy", the default; capabilities.attachment =
//   false): effectiveInline is true, so addFiles takes the INLINE branch. It
//   does NOT upload; instead it holds the raw File keyed by a synthetic
//   localId ("inl" + monotonic counter; fresh page -> "inl1"), renders a chip
//   whose url is vh-attach:<localId>, and INSERTS A MARKDOWN REF at the
//   textarea caret: ![shot.png](vh-attach:inl1). The composer textarea value
//   therefore carries the ref text (NOT empty). Upload is deferred to send()
//   via resolveInlineAttachments (lib/inlineAttach.ts S4).
//
//   VISION (fixture model "dummy-think"; capabilities.attachment = true):
//   effectiveInline is false, so addFiles takes the UPLOAD branch. For a LIVE
//   session it uploads eagerly via /vh/attach, the chip shows a server-backed
//   url, and the composer textarea STAYS EMPTY (no text inserted).
//
// Both regimes must keep the chip visible (the harvest -> chip wiring is
// shared). The textarea assertion is what distinguishes them, so the old
// single toHaveValue("") assertion was STALE for the now-default non-vision
// path and is replaced by the parameterized pair below.
//
// The fixture server is a REAL vh-solara aggregator + web server against a fake
// OpenCode (tools/fixtureserver). /vh/attach is real and writes the uploaded
// file to <demoDir>/.vh-solara/sessions/<sid>/attachments. The fake OpenCode
// (pkg/fixtures/opencode.go simulatePrompt) DROPS file parts from its echoed
// user message, so the round-trip is verified on-disk, not via a transcript
// .file-chip.

// Mirror web/tests/e2e/composer.spec.ts: grant clipboard permissions for the
// paste-button path (harmless for the synthetic-ClipboardEvent path used here).
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// Dispatch a synthetic paste carrying a PNG File onto the composer textarea.
//
// CRITICAL for making this a real regression guard: a programmatically-created
// DataTransfer normally populates BOTH .items AND .files when you items.add() a
// File, so a naive synthetic paste would attach the file even via the old,
// files-only code path and never exercise the fix. To reproduce the actual
// "Ctrl+V does nothing" symptom, we blank ClipboardData.files so the file
// surfaces ONLY via .items — exactly the condition harvestPastedFiles was added
// to recover from.
async function pasteImage(page: Page, filename = "shot.png") {
  const ta = page.getByPlaceholder(/Message/);
  await ta.evaluate((el, name) => {
    const dt = new DataTransfer();
    // Minimal valid PNG header (8 signature bytes) so the File carries real
    // image/png bytes.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = new File([bytes], name, { type: "image/png" });
    dt.items.add(file);
    // Reproduce browsers that expose a pasted image ONLY via clipboardData.items
    // while clipboardData.files stays empty (the regression this test guards).
    // Without the items-first harvest in lib/paste.ts, reading .files alone
    // attaches nothing — the "does nothing" symptom.
    Object.defineProperty(dt, "files", { get: () => [] as unknown as FileList });
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }, filename);
}

// --- Test 1: existing chat session, BOTH attachment regimes ------------------
// Covers symptom #2 ("does nothing"): pasting a file that surfaces only via
// .items still attaches it. The composer-side effect differs by regime (see the
// header comment), so the pair asserts the regime-specific textarea state in
// addition to the shared chip-visibility guard.
//
// Regime table. `switchModel` mirrors the model-select interaction in
// features.spec.ts (open .model-btn dialog, pick the row, assert .model-btn-name).
// `expectInline` selects the textarea assertion: inline regime inserts a
// markdown ref; upload regime leaves the composer empty.
const liveSessionRegimes = [
  {
    title: "non-vision (dummy) inserts an inline markdown ref",
    switchModel: false,
    expectInline: true,
  },
  {
    title: "vision (dummy-think) uploads and leaves the composer empty",
    switchModel: true,
    expectInline: false,
  },
] as const;

for (const regime of liveSessionRegimes) {
  test(`paste into an existing chat session attaches the file (items-only harvest) — ${regime.title}`, async ({
    page,
  }) => {
    await page.goto(projectUrl("/"));
    await page.getByRole("button", { name: /Demo session/ }).click();
    const ta = page.getByPlaceholder(/Message/);

    if (regime.switchModel) {
      // Switch to the vision fixture model so addFiles takes the upload branch.
      // Mirrors features.spec.ts:8-25 (open dialog, pick row, assert button).
      await page.locator(".model-btn").click();
      const dialog = page.getByRole("dialog", { name: "Select model" });
      await expect(dialog).toBeVisible();
      await dialog.getByText("Dummy Thinking").click();
      await expect(page.getByRole("dialog", { name: "Select model" })).toHaveCount(0);
      // Gate paste on the model actually taking effect before asserting regime.
      await expect(page.locator(".model-btn-name")).toContainText("Dummy Thinking");
    } else {
      // The default selected model on the Demo session is the non-vision
      // "dummy" fixture (features2.spec.ts:14); confirm it so the inline
      // branch below is unambiguous.
      await expect(page.locator(".model-btn-name")).toContainText("Dummy Model");
    }

    await pasteImage(page);

    // Shared guard: the harvested file becomes an attachment chip showing its
    // filename regardless of regime (inline chip uses a synthetic url; upload
    // chip uses a server-backed url — both carry the filename).
    const chip = page.locator(".attach-chip", { hasText: "shot.png" });
    await expect(chip).toBeVisible({ timeout: 8000 });

    if (regime.expectInline) {
      // Non-vision / inline regime: addFiles inserted a markdown ref at the
      // caret instead of uploading. Match the pattern (not a hard-coded
      // localId) so this stays robust as the monotonic counter grows within
      // a page: ![shot.png](vh-attach:inl<N>).
      await expect(ta).toHaveValue(/!\[shot\.png\]\(vh-attach:inl\d+\)/);
    } else {
      // Vision / upload regime: addFiles uploaded eagerly; no text was
      // inserted into the composer.
      await expect(ta).toHaveValue("");
    }
  });
}

// --- Test 2: draft hero attaches WITHOUT navigating away --------------------
// Covers symptom #1 ("switches to empty session, attachment lost"): pasting into
// the "Start a new session" draft hero must queue the attachment locally and
// must NOT create a session / navigate away. Regime-agnostic for the draft path
// (both inline and non-inline branches queue locally without navigating).
test("paste into the draft hero attaches without creating a session", async ({ page }) => {
  await page.goto(projectUrl("/"));
  const treeNew = page.locator(".tree-node", { hasText: "New session" });
  const before = await treeNew.count();

  // Enter draft mode WITHOUT creating a server session (mirrors ux.spec.ts:77).
  await page.getByRole("button", { name: "Create session" }).click();
  const hero = page.locator(".chat-hero-title");
  await expect(hero).toHaveText("Start a new session");

  await pasteImage(page);

  // The attachment is queued locally (no session id yet -> no upload, no
  // navigation) and the chip survives.
  const chip = page.locator(".attach-chip", { hasText: "shot.png" });
  await expect(chip).toBeVisible({ timeout: 8000 });

  // KEY regression guard: the draft hero is still on screen — paste did NOT
  // navigate away or create a session.
  await expect(hero).toBeVisible();

  // And no new "New session" node materialized in the tree before the first
  // message is sent.
  await expect(treeNew).toHaveCount(before);
});

// --- Test 3: sending the draft uploads the pending attachment --------------
// Covers the second half of symptom #1: once the user sends the first message,
// the session is created AND the queued attachment is uploaded into it (not
// silently lost).
test("sending the draft uploads the pending attachment to the new session", async ({ page }) => {
  await page.goto(projectUrl("/"));
  const treeNew = page.locator(".tree-node", { hasText: "New session" });
  const before = await treeNew.count();

  await page.getByRole("button", { name: "Create session" }).click();
  await pasteImage(page);
  await expect(page.locator(".attach-chip", { hasText: "shot.png" })).toBeVisible({ timeout: 8000 });

  // First message materializes the session; send() runs ensureSession() then
  // flushPendingAttachments(id) which uploads the queued File now that a
  // session id exists.
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill("here is the screenshot");
  await page.keyboard.press("Enter");

  // A new session node appears (creation happened).
  await expect(treeNew).toHaveCount(before + 1, { timeout: 8000 });

  // The attachment round-tripped: it landed on disk under the NEW session's
  // .vh-solara attachments dir. The fake OpenCode fixture drops file parts from
  // its echoed user message, so the on-disk file is the proof the upload ran.
  // (The new session's attachments dir is empty before send, so finding the
  // file there is unambiguous.)
  //
  // The new session id lands in ?session= once createSession()'s POST resolves
  // and setSelectedId() → syncUrl() pushes it. That fetch is a SEPARATE async
  // path from the session.created stream event that surfaced the tree node
  // above, so the URL can lag the tree by a tick — poll instead of reading once
  // or this races (flake: tree shown, ?session= still null).
  await expect.poll(
    () => new URL(page.url()).searchParams.get("session"),
    { timeout: 10000, message: "URL ?session=<ses_newN> after draft send" },
  ).toMatch(/^ses_new\d+$/);
  const sid = new URL(page.url()).searchParams.get("session")!;
  const dir = path.join(demoDir, ".vh-solara", "sessions", sid!, "attachments");
  await expect.poll(
    async () => {
      try {
        const files = await fs.readdir(dir);
        return files.some((f) => f.endsWith("shot.png"));
      } catch {
        return false;
      }
    },
    { timeout: 10000, message: `attachment shot.png under ${dir}` },
  ).toBe(true);
});
