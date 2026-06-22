import { expect, test } from "@playwright/test";

// A consumer registers an embedded view; the SPA surfaces it as a button in the
// view-switcher and mounts a sandboxed iframe at its path prefix. We point at an
// unreachable upstream — only the SPA surface (button + iframe attrs) is under
// test here; the proxy/prefix contract is covered by the Go TestViewProxyContract.
test("a registered embedded view shows a button and mounts a sandboxed iframe", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/vh/views", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({
        view_id: "e2e",
        title: "E2E View",
        path_prefix: "/e2eview",
        upstream: "http://127.0.0.1:9",
        sandbox: "allow-scripts allow-same-origin",
      }),
    });
  });
  // The SPA refreshes the view list on mount — reload to pick up the new one.
  await page.reload();

  const btn = page.getByRole("button", { name: "E2E View", exact: true });
  await expect(btn).toBeVisible();
  await btn.click();

  const frame = page.locator("iframe.view-frame");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("src", "/e2eview/");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");

  // Unregister so the registration doesn't leak into other specs' state.
  await page.evaluate(() =>
    fetch("/vh/views?view_id=e2e", { method: "DELETE", headers: { "X-VH-CSRF": "1" } }),
  );
});
