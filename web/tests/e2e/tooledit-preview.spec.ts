import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// DEFER closers for commit a486e2a ("render edit/write tool contents as inline
// diff in ToolPart"):
//
// DEFER 1 (CSS-class wiring): Vitest does not process CSS modules, so the
// .tool-edit-del/.tool-edit-add/.tool-edit-meta classList mapping in ToolPart
// could be renamed or dropped while every unit test stays green (the diff
// renders but is uncolored). These specs run against the BUILT SPA, where Vite
// hashes module classes (`<file>__<local>___<hash>` by default), so the scoped
// classes are asserted with substring attribute selectors —
// [class*="tool-edit-del"] etc. — which match the hashed names regardless of
// the generated prefix/suffix convention.
//
// DEFER 2 (expand-interaction path): no test exercised expanding a NON-tail
// tool row (the disclosure defaults closed for every part except the
// streaming tail) and then observing the preview. Test 1 drives a real click
// on .tool-head; test 2 drives keyboard activation (Enter via onActionKey).
//
// Both tests are read-only w.r.t. the shared fixture backend: no prompts, no
// pins/labels, and tool-row expansion state (partOpen) is page-local.

test("clicking a non-tail edit row's head expands the scoped del/add preview", async ({ page }) => {
  // The demo session's p3 edit part sits in m2's activity group — a settled,
  // mid-history group — so the row is NOT the streaming tail and its
  // disclosure starts CLOSED.
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });
  // The only "Edit File"-labelled tool in the seeded demo transcript.
  // (.first() tolerates turn text other specs may have appended to demo; the
  // fixture's prompt responses stream text only — never edit tools.)
  const editRow = page.locator(".tool").filter({ hasText: "Edit File" }).first();
  await expect(editRow).toBeVisible();
  // Collapsed disclosure gate: the preview lines are not in the DOM at all.
  await expect(editRow.locator('[class*="tool-edit-del"]')).toHaveCount(0);
  await expect(editRow.locator('[class*="tool-edit-add"]')).toHaveCount(0);
  // DEFER 2: real click on the head of a non-tail row.
  await editRow.locator(".tool-head").click();
  // DEFER 1: the scoped classes ride the del/add lines (hashed by the build —
  // matched by substring, see header).
  const del = editRow.locator('[class*="tool-edit-del"]');
  const add = editRow.locator('[class*="tool-edit-add"]');
  await expect(del).toHaveCount(1);
  await expect(add).toHaveCount(1);
  await expect(del).toHaveText("func parse() {}");
  await expect(add).toHaveText("func parse(s string) {}");
  // The mapping is kind-specific: the del line's class carries the del class
  // and NOT the add class (a swapped/renamed binding fails here even though
  // the text assertions above still pass).
  const delClass = (await del.getAttribute("class")) ?? "";
  expect(delClass).toContain("tool-edit-del");
  expect(delClass).not.toContain("tool-edit-add");
  // A plain single-site edit renders no meta line.
  await expect(editRow.locator('[class*="tool-edit-meta"]')).toHaveCount(0);
});

test("keyboard-activating a replaceAll edit row shows the scoped meta header", async ({ page }) => {
  // The dedicated "editpvw" session (see pkg/fixtures/opencode.go) holds one
  // completed edit part with replaceAll: true and multi-line old/new strings.
  await page.goto(projectUrl("/?session=editpvw"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });
  const editRow = page.locator(".tool").filter({ hasText: "Edit File" }).first();
  await expect(editRow).toBeVisible();
  await expect(editRow.locator('[class*="tool-edit-meta"]')).toHaveCount(0);
  // DEFER 2 (keyboard arm): Enter on the focused head — .tool-head is
  // role="button" tabindex="0" and activates via onActionKey (Enter/Space).
  const head = editRow.locator(".tool-head");
  await head.focus();
  await head.press("Enter");
  // replaceAll prepends the "replaces every match" meta line, carrying the
  // scoped meta class.
  const meta = editRow.locator('[class*="tool-edit-meta"]');
  await expect(meta).toHaveCount(1);
  await expect(meta).toHaveText("replaces every match");
  // Multi-line blocks: EVERY line carries its block-kind class (4 del + 4 add —
  // each fixture block is 4 lines; editDiffLines drops only a trailing EMPTY
  // segment, and the final "}" is real content).
  await expect(editRow.locator('[class*="tool-edit-del"]')).toHaveCount(4);
  await expect(editRow.locator('[class*="tool-edit-add"]')).toHaveCount(4);
  await expect(editRow.locator('[class*="tool-edit-del"]', { hasText: "c, err := acquire()" })).toHaveCount(1);
  await expect(editRow.locator('[class*="tool-edit-add"]', { hasText: "c, err := get()" })).toHaveCount(1);
});
