import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { demoDir, projectUrl } from "./util";

// e2e coverage for the composer paste -> attachment wiring, guarding the paste
// fix that lives (uncommitted) in web/src/lib/paste.ts (harvestPastedFiles) and
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
// "Ctrl+V does nothing" symptom, we blank clipboardData.files so the file
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

// --- Test 1: existing chat session ------------------------------------------
// Covers symptom #2 ("does nothing"): pasting a file that surfaces only via
// .items still attaches it. For a LIVE session addFiles uploads immediately, so
// the named chip only renders once the /vh/attach round-trip succeeds.
test("paste into an existing chat session attaches the file (items-only harvest)", async ({
  page,
}) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const ta = page.getByPlaceholder(/Message/);

  await pasteImage(page);

  // The harvested file becomes an attachment chip showing its filename. For a
  // live session the chip appears only after uploadFile() completes.
  const chip = page.locator(".attach-chip", { hasText: "shot.png" });
  await expect(chip).toBeVisible({ timeout: 8000 });

  // A harvested file paste calls preventDefault(); no stray text is inserted
  // into the composer.
  await expect(ta).toHaveValue("");
});

// --- Test 2: draft hero attaches WITHOUT navigating away --------------------
// Covers symptom #1 ("switches to empty session, attachment lost"): pasting into
// the "Start a new session" draft hero must queue the attachment locally and
// must NOT create a session / navigate away.
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
