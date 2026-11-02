// A2 — real-browser interaction receipt for the PWA recurrence-capture
// instrument (DiagLogDialog). Unit tests cover the dialog's rendering logic,
// but three steps of the operator path had never been driven by real browser
// gestures:
//   1. the OPEN path — right-click Settings → Server admin popup →
//      "Diagnostic log" entry → the dialog renders (layout.spec.ts drives
//      the admin popup for other entries; this one was undriven in lane 6);
//   2. the <details> snapshot expansion — a NATIVE toggle, no JS (no lane-6
//      precedent drives a details toggle at all; this is the first);
//   3. the real clipboard write — "Copy all" → navigator.clipboard.writeText.
//      CRITICAL: copyAll() swallows clipboard failure silently (empty catch),
//      so NO in-app assertion can detect a denied/failed write — reading the
//      clipboard back IS the assertion.
// The __vhSyncDiag snapshot getter installs on every real boot (startSync →
// installSyncDiagGlobal, recovery-reasons.ts), so no seeding is needed; with
// capture off by default (diaglog.ts) and a fresh context, the combined
// payload is exactly the snapshot section under its separator.

import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test.describe("diag log instrument (real gesture chain)", () => {
  // Clipboard permissions up front: copyAll's write needs clipboard-write,
  // the read-back assertion needs clipboard-read (composer.spec.ts:57
  // precedent; the read-back poll pattern is projects.spec.ts:471-474, which
  // also notes clipboard reads can be flaky — hence the poll-with-timeout).
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("opens via right-click Settings → Server admin, expands the sync snapshot, and Copy all lands the combined payload in the clipboard", async ({
    page,
  }) => {
    await page.goto(projectUrl("/"));

    // 1. OPEN PATH — the operator gesture chain (layout.spec.ts:27 precedent
    //    for the right-click): the Settings right-click opens the Server
    //    admin popup, whose "Diagnostic log" entry (AdminMenu.tsx) closes
    //    the popup and mounts this dialog.
    await page.getByRole("button", { name: "Settings" }).click({ button: "right" });
    const pop = page.getByRole("dialog", { name: "Server admin" });
    await pop.getByRole("button", { name: "Diagnostic log" }).click();
    const dlg = page.getByRole("dialog", { name: "Diagnostic log" });
    await expect(dlg).toBeVisible();

    // 2. SNAPSHOT EXPANSION — the snapshot lives in a native <details>,
    //    collapsed by default, toggled by a plain summary click (no JS).
    //    Assert the content actually becomes visible, and that the getter
    //    really ran: the section carries snapshot JSON (SyncDiagSnapshot
    //    top-level keys), not the "not installed" fallback.
    const snapshot = dlg.getByLabel("Sync snapshot");
    await expect(snapshot).toBeHidden();
    await dlg.getByText("Sync snapshot (__vhSyncDiag)").click();
    await expect(snapshot).toBeVisible();
    await expect(snapshot).toContainText('"recovery"');
    await expect(snapshot).toContainText('"generatedAt"');

    // 3. REAL CLIPBOARD WRITE + READ-BACK — copyAll() catches clipboard
    //    errors silently, so a UI assertion cannot detect failure; the
    //    read-back is the assertion. Capture is off by default and this
    //    context is fresh (zero entries), so the combined payload is
    //    exactly the snapshot section under its separator (allText's
    //    0-entries branch). The pre's text IS the frozen snapshot the
    //    dialog captured at open — the exact bytes copyAll writes.
    const snapshotText = (await snapshot.textContent()) ?? "";
    expect(snapshotText, "snapshot section carries JSON").not.toBe("");
    await dlg.getByRole("button", { name: "Copy all" }).click();
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toBe(`--- __vhSyncDiag ---\n${snapshotText}`);
  });
});
