// Outbox epoch mechanism — real-IndexedDB e2e coverage (the defer of the
// 02990c9 outbox epoch marker slice). The v1→v2 DB upgrade, the mutation
// epoch (txBumpEpoch), and the localStorage pending-marker cross-check
// (hydrateOutbox) were only unit-tested against the in-memory fake until
// now; this spec drives them against the REAL engine in the REAL browser
// (deliberately NO fake-indexeddb dependency — that absence is the point).
//
// Scenarios:
//   T1 (crux — v1→v2 migration): a REAL v1 database (gestures store only,
//      one backdated saved record, legacy bare-number marker) is seeded
//      before the app boots → the app's REAL openDb upgrade fires → the meta
//      store appears, the seeded record SURVIVES (reconcile re-admits it to
//      exactly ONE chip), no eviction banner, and the legacy marker is
//      repaired to the v2 JSON shape on first hydrate.
//   T2 (eviction verdict, fresh DB): a v2 marker {"n":1,"e":5} + a deleted
//      database → the app boots on a fresh epoch-0 DB → the conservative
//      warn branch fires (epoch 0 + n>0 legitimately warns: the epoch was
//      wiped WITH the store) → the "Locally saved messages were cleared."
//      banner renders.
//   T3 (stale marker stays silent): an empty store whose meta.epoch (5) has
//      advanced past the marker's e (1) → NO banner; the marker is repaired
//      silently (n=0 → key removed). The epoch-mismatch repair is exactly
//      the interleaved-multi-tab-writes case the epoch exists to detect.
//
// Seeding hazard (why this spec rolls its own helpers): the shared helpers
// in send-outbox-resilience.spec.ts (primeOutboxRecordForReAdmit /
// deleteOutboxRecords) mutate `gestures` WITHOUT touching `meta.epoch` —
// any epoch-sensitive seeding must write the epoch itself. All seeding here
// happens in a page.addInitScript that runs BEFORE app modules load (the
// outbox module caches its DB connection at boot hydrate), via a two-load
// idiom: load 1 seeds while a scenario-F-style failing-open wrapper keeps
// the app entirely off the outbox DB (so the seed script owns the version
// history — a racing app open would either run the upgrade itself or
// reject onblocked and skip the boot hydrate under test), then a reload
// boots the REAL store on the seeded state with no competing connection.
//
// Hygiene: part of the serial suite over the shared fixtureserver (same
// pattern as send-outbox-resilience.spec.ts — queue state owned + cleaned
// per test via the real queue API; the outbox DB is per-test-fresh because
// Playwright gives each test its own context). Chromium-only: the firefox
// projects in playwright.config.ts are testMatch-scoped (codeview /
// zoom-placement / animation-resume) and this file matches none of them.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

// The seeded DEMO session (send-outbox-resilience.spec's precedent): the
// reconcile path targets it and its queue is owned + cleaned per test.
const SID = "demo";
const jsonCsrf = { "Content-Type": "application/json", "X-VH-CSRF": "1" };
const DB_NAME = "vh-solara-outbox";
const LS_MARKER = "vh.outbox.pending.v1";
// Unique-per-run intentId is minted INSIDE the seed script; the test reads
// it back from the surviving record (single source of truth).
const T1_TEXT = "v1 to v2 migration survivor";

function apiUrl(suffix = ""): string {
  return `/vh/session/${SID}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
}

/** Same retry-clean hygiene as send-outbox-resilience.spec.ts's cleanQueue:
 *  remove every queue item, retrying stuck `dispatching` items past the
 *  daemon's 30s stale-dispatch threshold. Self-healing against leftovers
 *  from previous runs (queue.json persists across fixtureserver restarts). */
async function cleanQueue(request: APIRequestContext): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const res = await request.get(apiUrl());
    if (!res.ok()) return;
    const j = await res.json().catch(() => ({}));
    const items: Array<{ id: string }> = Array.isArray(j.items) ? j.items : [];
    if (items.length === 0) return;
    let stuck = false;
    for (const it of items) {
      const del = await request.delete(apiUrl(`/${encodeURIComponent(it.id)}`), { headers: jsonCsrf });
      if (!del.ok()) stuck = true; // 409 dispatching — not yet stale
    }
    if (!stuck) return;
    if (Date.now() > deadline) return; // bounded: never wedge the suite
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function listQueue(request: APIRequestContext): Promise<any[]> {
  const res = await request.get(apiUrl());
  expect(res.ok(), "queue list").toBeTruthy();
  const j = await res.json();
  return Array.isArray(j.items) ? j.items : [];
}

async function openSession(page: Page): Promise<void> {
  await page.goto(projectUrl("/?session=" + SID));
}

/** Read every outbox gesture record from inside the page (the REAL IDB path
 *  — send-outbox-resilience.spec.ts's readOutbox, unchanged). */
async function readOutbox(page: Page): Promise<Array<{ intentId: string; status: string; queueItemId?: string }>> {
  return page.evaluate(
    () =>
      new Promise<any[]>((resolve) => {
        const open = indexedDB.open("vh-solara-outbox");
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("gestures")) {
            db.close();
            return resolve([]);
          }
          const req = db.transaction("gestures", "readonly").objectStore("gestures").getAll();
          req.onsuccess = () => {
            db.close(); // called inside poll loops — never leak connections
            resolve(req.result ?? []);
          };
          req.onerror = () => {
            db.close();
            resolve([]);
          };
        };
      }),
  );
}

/** Version + store names + the meta epoch, read through a versionless open
 *  (never requests an upgrade, so it can never be blocked by the app's
 *  cached connection). PRECONDITION: call only AFTER the app booted (a
 *  versionless open of a not-yet-created DB would silently create an empty
 *  v1 database and wreck the posture — every call site here is post-boot).
 *  Epoch is -1 when the meta store/key is absent. */
async function readDbFacts(page: Page): Promise<{ version: number; stores: string[]; epoch: number }> {
  return page.evaluate(
    (dbName: string) =>
      new Promise<any>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error ?? new Error("facts open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const version = db.version;
          const stores = Array.from(db.objectStoreNames) as string[];
          if (!db.objectStoreNames.contains("meta")) {
            db.close();
            resolve({ version, stores, epoch: -1 });
            return;
          }
          const tx = db.transaction("meta", "readonly");
          const req = tx.objectStore("meta").get("epoch");
          let epoch = -1;
          req.onsuccess = () => {
            epoch = Number(req.result) || 0;
          };
          tx.oncomplete = () => {
            db.close();
            resolve({ version, stores, epoch });
          };
          tx.onerror = () => {
            db.close();
            resolve({ version, stores, epoch: -1 });
          };
        };
      }),
    DB_NAME,
  );
}

type SeedMode = "t1-v1-migration" | "t2-fresh-eviction" | "t3-stale-marker";

/** Seed the outbox DB + pending marker BEFORE the app boots, via the two-load
 *  idiom (see the file header). Returns after the reload, i.e. with the app
 *  booting for real on the seeded state. */
async function seedOutboxState(page: Page, mode: SeedMode): Promise<void> {
  await page.addInitScript((mode: string) => {
    const DB = "vh-solara-outbox";
    const LS_KEY = "vh.outbox.pending.v1";
    const RUN = "__outboxEpochSeedRan";
    // The reload is inert: seeding already committed, and the wrapper below
    // must NOT be installed on load 2 (the real store must boot unblocked).
    if (sessionStorage.getItem(RUN)) return;
    sessionStorage.setItem(RUN, "1");
    // Scenario F's failing-open wrapper, scoped to the seed load only: keep
    // the app ENTIRELY off the outbox DB so the seed script owns the version
    // history (a racing app open would run the upgrade itself — v1 seeding
    // lost — or reject onblocked and skip the boot hydrate under test).
    const origOpen = indexedDB.open.bind(indexedDB);
    const failOpen = (name: string) => {
      const err = new DOMException("seed-load gate: " + name, "UnknownError");
      const req: any = {
        error: err,
        result: undefined,
        readyState: "pending",
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      setTimeout(() => {
        if (typeof req.onerror === "function") req.onerror({ target: req, type: "error" });
      }, 0);
      return req;
    };
    indexedDB.open = function (this: IDBFactory, name: string, version?: number) {
      if (name === DB) return failOpen(name);
      return origOpen(name, version);
    } as typeof indexedDB.open;
    const seed = (async () => {
      if (mode === "t1-v1-migration") {
        // The v1 posture: gestures store only, one backdated saved record
        // (the primeOutboxRecordForReAdmit record shape — past the 60s
        // READMIT_MIN_AGE_MS guard, null capturedHead so the stale gate
        // never fabricates staleness), and a legacy bare-number marker.
        localStorage.setItem(LS_KEY, "3");
        await new Promise<void>((resolve, reject) => {
          const open = origOpen(DB, 1);
          open.onupgradeneeded = () => {
            open.result.createObjectStore("gestures", { keyPath: "intentId" });
          };
          open.onerror = () => reject(open.error ?? new Error("seed open failed"));
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("gestures", "readwrite");
            tx.objectStore("gestures").put({
              intentId: "seed-v1-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2),
              sessionId: "demo",
              createdAt: Date.now() - 120_000,
              payload: { text: "v1 to v2 migration survivor", attachments: [] },
              capturedHead: null,
              status: "saved",
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("seed tx aborted"));
          };
        });
      } else if (mode === "t2-fresh-eviction") {
        // The whole-DB-eviction posture: a v2 marker claiming one pending
        // record at epoch 5, and no database at all (fresh context; the
        // delete is belt-and-braces so the shape holds even if a DB leaked).
        localStorage.setItem(LS_KEY, JSON.stringify({ n: 1, e: 5 }));
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(DB);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          // A blocked delete means an open connection survived the fresh
          // context premise — the posture would be wrong, so fail loudly
          // instead of seeding a half-deleted database.
          req.onblocked = () => reject(new Error("seed deleteDatabase blocked"));
        });
      } else {
        // t3-stale-marker: an EMPTY store whose meta.epoch (5) advanced past
        // the marker's e (1) — the detectably-stale marker shape (a tracked
        // put/delete committed after the snapshot; e.g. its marker persist
        // was lost to a tab kill). Epoch write is direct IDB — the shared
        // helpers never touch meta.
        localStorage.setItem(LS_KEY, JSON.stringify({ n: 1, e: 1 }));
        await new Promise<void>((resolve, reject) => {
          const open = origOpen(DB, 2);
          open.onupgradeneeded = () => {
            const db = open.result;
            db.createObjectStore("gestures", { keyPath: "intentId" });
            db.createObjectStore("meta");
          };
          open.onerror = () => reject(open.error ?? new Error("seed open failed"));
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("meta", "readwrite");
            tx.objectStore("meta").put(5, "epoch");
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("seed tx aborted"));
          };
        });
      }
    })();
    seed.then(
      () => {
        (window as any).__outboxEpochSeedDone = true;
      },
      (e) => {
        (window as any).__outboxEpochSeedDone = "seed failed: " + String(e);
      },
    );
  }, mode);
  // Load 1: the seed script runs to completion against the real engine
  // (fail loudly if it did not — every downstream assertion would be
  // testing the wrong posture otherwise).
  await openSession(page);
  await page.waitForFunction(() => (window as any).__outboxEpochSeedDone !== undefined);
  const done = await page.evaluate(() => (window as any).__outboxEpochSeedDone);
  expect(done, "seed script completed on load 1").toBe(true);
  // Load 2: the real store boots on the seeded state.
  await page.reload();
}

test.beforeEach(async ({ request }, testInfo) => {
  testInfo.setTimeout(120_000);
  await cleanQueue(request);
});

test.afterEach(async ({ request }) => {
  await cleanQueue(request);
});

// --- T1. v1→v2 migration (the crux) ---------------------------------------------
test("T1: v1→v2 migration — real upgrade creates meta, preserves the record (one chip, no duplicate), repairs the legacy marker, no eviction banner", async ({
  page,
  request,
}) => {
  // Keep the re-admitted item `pending` (scenario A/F's posture): the claim
  // is aborted at the page route so the drainer can never deliver it, and
  // the afterEach cleanup deletes a pending item cleanly (no 409).
  await page.route(`**/vh/session/${SID}/queue/claim*`, (route) => route.abort());
  // GATE the re-admission enqueue POST (scenario B/D's isQueueListUrl
  // predicate idiom — the exact /queue path, never claim/resolve sub-paths;
  // the SPA's queue URLs carry no query, the project dir travels in the
  // x-opencode-directory header). Holding the POST holds the WHOLE later
  // marker-write chain (markAdmitted's put + persistPendingMarker): the only
  // writer that can have touched the marker by then is hydrateOutbox — which
  // pins the legacy→v2 repair to HYDRATE, unmaskable by the admission
  // path's own marker write (commit-review F3).
  let releaseEnqueue: (() => void) | null = null;
  const enqueueGate = new Promise<void>((r) => {
    releaseEnqueue = r;
  });
  const isQueueListUrl = (url: URL) => new RegExp(`/vh/session/${SID}/queue(\\?.*)?$`).test(url.href);
  await page.route(isQueueListUrl, async (route) => {
    if (route.request().method() === "POST") await enqueueGate;
    return route.continue();
  });
  await seedOutboxState(page, "t1-v1-migration");
  // Session-selection guard (send-outbox-resilience B's rationale): the
  // session-open reconcile targets the SELECTED demo session.
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  // The re-admission POST is now HELD by the gate. With no mutation able to
  // commit, the marker can only be hydrateOutbox's repair of the seeded
  // legacy "3" — and it reads {n:1, e:0}: one record, the PRE-admission
  // epoch (any admission-path marker write would carry e=1). This is the
  // independent legacy-repair proof, asserted BEFORE admission is released.
  await expect
    .poll(
      async () => {
        const raw = await page.evaluate((key: string) => localStorage.getItem(key), LS_MARKER);
        try {
          const j = JSON.parse(raw as string);
          return typeof j.n === "number" && typeof j.e === "number" && j.n === 1 && j.e === 0
            ? "ok"
            : (raw ?? "null");
        } catch {
          return raw ?? "null";
        }
      },
      { timeout: 10_000 },
    )
    .toBe("ok");
  // Release the held POST: the re-admission proceeds for real.
  releaseEnqueue!();
  // The SURVIVING record reconciles to exactly ONE chip: the boot reconcile
  // re-admitted the backdated saved record under its ORIGINAL intentId
  // (createQueueSync: reconcile BEFORE fetch, so the item is cached for the
  // first render).
  await expect(page.locator(".queue-chip", { hasText: T1_TEXT })).toBeVisible({ timeout: 15_000 });
  // The record is admitted + linked to its queue item (poll — markAdmitted
  // commits a beat after the enqueue).
  await expect
    .poll(
      async () => {
        const recs = await readOutbox(page);
        return recs.length === 1 && recs[0].status === "admitted" ? recs[0] : null;
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();
  const survivor = (await readOutbox(page))[0] as any;
  expect(survivor.payload.text).toBe(T1_TEXT); // the SEEDED record — same identity
  expect(survivor.queueItemId).toBeTruthy();
  // The REAL upgrade ran: version 2, BOTH stores, and EXACTLY ONE epoch bump
  // — markAdmitted's put is the only post-upgrade mutation, and its
  // txBumpEpoch co-commit advanced 0→1 on the real path (a double-bump or a
  // lost bump both fail this).
  const facts = await readDbFacts(page);
  expect(facts.version).toBe(2);
  expect(facts.stores).toContain("gestures");
  expect(facts.stores).toContain("meta");
  expect(facts.epoch).toBe(1);
  // NO duplicate: exactly one server item, under the record's intentId.
  const items = await listQueue(request);
  expect(items).toHaveLength(1);
  expect(items[0].intentId ?? items[0].attemptId).toBe(survivor.intentId);
  // NO eviction banner: the legacy bare-number marker never warns (it is
  // exactly the untrusted racy count the v2 design replaces).
  await expect(page.getByTestId("outbox-storage-banner")).toHaveCount(0);
  // The marker is STILL v2 JSON after the admission path's own marker write
  // (the shape held; only the epoch binding moved 0→1).
  const rawMarker = await page.evaluate((key: string) => localStorage.getItem(key), LS_MARKER);
  expect(rawMarker, "marker migrated (not removed — one record is pending)").toBeTruthy();
  expect(rawMarker!.startsWith("{"), "marker is v2 JSON, not a bare number").toBe(true);
  const marker = JSON.parse(rawMarker!);
  expect(marker.n).toBe(1);
  expect(marker.e).toBe(1);
});

// --- T2. eviction verdict on a fresh epoch-0 DB ----------------------------------
test("T2: fresh epoch-0 DB + v2 marker n>0 → the 'Locally saved messages were cleared.' eviction banner (conservative warn)", async ({
  page,
}) => {
  await seedOutboxState(page, "t2-fresh-eviction");
  // ChatView must be mounted for the banner (session view, not draft).
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  // The eviction notice — the exact contract phrase, first time asserted in
  // any lane. Epoch 0 + n>0 legitimately warns: the epoch was wiped WITH
  // the store (whole-DB eviction), so the marker's claim stands unrefuted.
  const banner = page.getByTestId("outbox-storage-banner");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText("Locally saved messages were cleared.");
  // Hydrate's marker bookkeeping for this verdict: the store is empty, so
  // the repair writes n=0 → the key is REMOVED (the warn already fired on
  // the v2 marker's evidence; the marker itself does not linger).
  await expect
    .poll(async () => page.evaluate((key: string) => localStorage.getItem(key), LS_MARKER), {
      timeout: 10_000,
    })
    .toBeNull();
  // The verdict's basis — a genuinely FRESH database: v2 schema, epoch 0,
  // no records.
  const facts = await readDbFacts(page);
  expect(facts.version).toBe(2);
  expect(facts.epoch).toBe(0);
  expect(await readOutbox(page)).toHaveLength(0);
});

// --- T3. stale marker stays silent -----------------------------------------------
test("T3: marker stale (store epoch advanced past marker.e) → NO banner; marker repaired silently", async ({
  page,
}) => {
  await seedOutboxState(page, "t3-stale-marker");
  // Order matters: FIRST prove hydrateOutbox ran (the stale marker was
  // repaired to n=0 → key REMOVED), so the no-banner assertion below is a
  // verdict — not a banner-that-has-not-rendered-yet artifact.
  await expect
    .poll(async () => page.evaluate((key: string) => localStorage.getItem(key), LS_MARKER), {
      timeout: 10_000,
    })
    .toBeNull();
  // ChatView mounted (the banner's only render site), then: NO banner.
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("outbox-storage-banner")).toHaveCount(0);
  // The repair is marker-side only: the store's epoch survived untouched.
  const facts = await readDbFacts(page);
  expect(facts.epoch).toBe(5);
});
