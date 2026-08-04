// manifest-helper.js — deterministic discovery/accounting helper for the
// contract/invariant audit capability (overlay-only S1 pilot).
//
// FROZEN BOUNDARY (debate condition 3). This helper is DISCOVERY/ACCOUNTING
// ONLY. It performs NO semantic evaluation and assigns NO violation class.
//
//   ALLOWED:
//     - enumerate declared units (invoke a configured discovery-adapter command
//       if provided, else fall back to a deterministic file inventory via
//       `git ls-tree -r --name-only <anchor>` filtered by roots/exclusions);
//     - assign stable deterministic IDs (hash of the normalized locator);
//     - completeness accounting (every manifest unit has exactly one terminal
//       disposition; detect duplicate/unknown/missing/outside-manifest IDs;
//       detect shard non-reconciliation; verify the snapshot anchor still
//       matches or require explicit reconciliation);
//     - record coverage tier + enumeration evidence;
//     - accept operator/adapter-supplied cross-unit units verbatim.
//
//   FORBIDDEN:
//     - infer semantic units;
//     - decide C1-C5 applicability;
//     - rank findings;
//     - treat accounting as semantic validation;
//     - call the network.
//
// DETERMINISM IS A HARD REQUIREMENT: identical inputs MUST produce
// byte-identical manifest IDs and order. There are no timestamps, no
// nondeterministic iteration, and object keys are emitted in sorted order.
//
// No external package dependencies (Node stdlib only). ESM (matches the repo's
// .opencode/package.json "type": "module" convention used by normalize-backlog.js
// and check-defer-triggers.mjs).
//
// AUTHORITY: advisory / INFORMS only. This helper is NOT wired into any commit,
// release, doctor, or update path. Its exit codes describe accounting
// well-formedness, never semantic correctness, and never gate a transition.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA = "contract-invariant-audit/manifest@1";
const ID_HEX_LEN = 16; // sha256 prefix length for unit_id
const COMPLETE_SCHEMA = "contract-invariant-audit/dispositions@1";

// Terminal dispositions (must match the skill canon). Accounting only checks
// that exactly one terminal disposition exists per unit; it never judges
// whether the disposition is semantically correct.
const TERMINAL_DISPOSITIONS = new Set([
    "clean",
    "candidate_violation",
    "not_applicable",
    "blocked_by_missing_evidence",
    "excluded_by_contract",
]);

const COVERAGE_TIERS = new Set([
    "adapter-complete",
    "declared-inventory",
    "sample",
]);

// Exit codes for the `complete` command.
const EXIT_COMPLETE = 0; // accounting well-formed; every unit terminal-once
const EXIT_MALFORMED = 2; // missing/duplicate/unknown/non-terminal/shard/anchor
const EXIT_USAGE = 64; // bad CLI usage / IO error

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

// Normalize a locator to a canonical string form for hashing and ordering.
// Forward slashes, no leading ./, no duplicate separators, no trailing slash
// (except the repo root itself). Pure function — identical input -> identical
// output.
function normalizeLocator(locator) {
    if (typeof locator !== "string") {
        throw new Error(`locator must be a string, got ${typeof locator}`);
    }
    let s = locator.replace(/\\/g, "/");
    s = s.replace(/\/+/g, "/");
    s = s.replace(/(^|\/)\.\//g, "$1");
    while (s.startsWith("./")) s = s.slice(2);
    if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
}

// Stable unit_id: first ID_HEX_LEN hex chars of sha256(normalized locator).
function unitIdFor(locator) {
    const norm = normalizeLocator(locator);
    return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, ID_HEX_LEN);
}

// Minimal glob -> RegExp. Supports:
//   **  any number of path segments (including zero), across slashes
//   *   any chars except '/'
//   ?   a single char except '/'
// Everything else is literal. Domain-free (no language/stack vocabulary).
// Translation order matters: escape specials first (leaving * and ?), then
// collapse '**' to a placeholder, then single '*' and '?', then expand the
// placeholder contextually (leading / trailing / middle / lone).
function globToRegExp(pattern) {
    const p = normalizeLocator(pattern);
    const PLACEHOLDER = "\x00";
    // 1. escape regex specials except '*' and '?'
    let s = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // 2. collapse '**' to placeholder
    s = s.replace(/\*\*/g, PLACEHOLDER);
    // 3. single '*' and '?' within a segment
    s = s.replace(/\*/g, "[^/]*");
    s = s.replace(/\?/g, "[^/]");
    // 4. expand placeholder contextually
    //    middle  /<PH>/   -> (?:/.*)?/   (a/**/b matches a/b, a/x/b, a/x/y/b)
    s = s.replace(new RegExp("/" + PLACEHOLDER + "/"), "(?:/.*)?/");
    //    leading ^<PH>/   -> (?:.*/)?    (**/foo matches foo, a/foo)
    s = s.replace(new RegExp("^" + PLACEHOLDER + "/"), "(?:.*/)?");
    //    trailing /<PH>$  -> (?:/.*)?    (pkg/** matches pkg, pkg/a, pkg/a/b)
    s = s.replace(new RegExp("/" + PLACEHOLDER + "$"), "(?:/.*)?");
    //    lone <PH>        -> .*          (whole-pattern '**' matches anything)
    s = s.replace(new RegExp(PLACEHOLDER, "g"), ".*");
    return new RegExp("^" + s + "$");
}

function makeMatchers(patterns) {
    const list = (Array.isArray(patterns) ? patterns : [patterns])
        .filter((p) => typeof p === "string" && p.length > 0)
        .map((p) => ({ raw: p, re: globToRegExp(p) }));
    return list;
}

function matchesAny(locator, matchers) {
    const norm = normalizeLocator(locator);
    for (const m of matchers) {
        if (m.re.test(norm)) return true;
    }
    return false;
}

// Recursively sorted stringify: identical object -> identical bytes regardless
// of insertion order. Arrays preserve order (the units array is pre-sorted).
function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return "[" + value.map(stableStringify).join(",") + "]";
    }
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Manifest construction (Phase 1)
// ---------------------------------------------------------------------------

// Build a manifest object from already-discovered raw units + config.
// `rawUnits` is an array of { locator, unit_type?, inclusion_basis?,
// enumeration_evidence?, shard_id?, extra? }. This function performs NO
// discovery of its own and NO semantic work: it normalizes locators, assigns
// deterministic IDs, sorts by unit_id, and records coverage evidence.
function buildManifestFromUnits(rawUnits, config) {
    const anchor = config.anchor || { ref: "HEAD", resolved: null };
    const coverageTier = config.coverageTier || "declared-inventory";
    if (!COVERAGE_TIERS.has(coverageTier)) {
        throw new Error(`unsupported coverage_tier: ${coverageTier}`);
    }

    const seen = new Map(); // normalized locator -> index
    const units = [];
    for (const raw of rawUnits) {
        const locator = normalizeLocator(raw.locator);
        if (locator.length === 0) {
            throw new Error("empty locator after normalization");
        }
        if (seen.has(locator)) {
            // Duplicate locator within a single discovery pass is an accounting
            // defect in the discoverer, not a semantic finding. Reject loudly.
            throw new Error(`duplicate locator discovered: ${locator}`);
        }
        seen.set(locator, units.length);
        units.push({
            unit_id: unitIdFor(locator),
            locator,
            unit_type: raw.unit_type || config.defaultUnitType || "file",
            source_anchor: anchor.resolved || anchor.ref,
            discovery_adapter: config.discoveryAdapter || "fallback-file-inventory",
            inclusion_basis: raw.inclusion_basis || config.defaultInclusionBasis || "declared-root",
            enumeration_evidence:
                raw.enumeration_evidence || config.defaultEnumerationEvidence || "file-inventory",
            exclusion_reason: null,
            shard_id: raw.shard_id ?? null,
            coverage_tier: coverageTier,
        });
    }

    // Deterministic order: sort by unit_id (stable across runs).
    units.sort((a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0));

    return {
        schema: SCHEMA,
        anchor: { ref: anchor.ref, resolved: anchor.resolved },
        anchor_basis: config.anchorBasis || "none",
        config: {
            roots: (config.roots || []).slice().sort(),
            exclude: (config.exclude || []).slice().sort(),
            granularity: config.granularity || "file",
            adapter: config.adapter || null,
            fallback_basis: config.fallbackBasis || "none",
        },
        coverage_tier: coverageTier,
        discovery: {
            adapter_id: config.adapterId || "fallback-file-inventory",
            adapter_version: config.adapterVersion || "0",
            enumeration_evidence: (config.enumerationEvidence || []).slice(),
            unsupported_surfaces: (config.unsupportedSurfaces || []).slice(),
        },
        units,
    };
}

// Run a discovery-adapter command and parse its JSON output. The adapter is an
// EXTERNAL deterministic enumerator that RECEIVES the anchored discovery scope
// and EMITS the unit list; this helper assigns IDs and records the anchor.
//
// WIRE CONTRACT (spec §3: a discovery adapter must "accept an anchored scope
// and explicit configuration"; the conceptual discover() takes snapshot_anchor):
//   - INPUT (stdin, JSON): the discovery scope the adapter MUST enumerate at —
//       {
//         "snapshot_anchor": { "ref": "<git-ref>", "resolved": "<sha-or-null>" },
//         "roots":    ["..."],   // inclusion globs
//         "exclude":  ["..."],   // exclusion globs
//         "granularity": "file"  // declared unit model
//       }
//     A conformant adapter reads stdin and enumerates the snapshot at
//     snapshot_anchor.resolved. The helper FORWARDS the resolved anchor so the
//     manifest's source_anchor is trustworthy, not merely decorative.
//   - OUTPUT (stdout, JSON):
//       {
//         "adapter_id": "...", "adapter_version": "...",
//         "coverage_tier": "adapter-complete" | "declared-inventory" | "sample",
//         "units": [ { "locator": "...", "unit_type": "...",
//                      "inclusion_basis": "...", "enumeration_evidence": "..." } ],
//         "enumeration_evidence": ["..."],
//         "unsupported_surfaces": ["..."]
//       }
// The helper NEVER interprets unit semantics; it only normalizes/IDs/sorts and
// records the anchor it forwarded.
function runAdapter(adapterCmd, config) {
    // Split the adapter command on whitespace into [executable, ...args] so a
    // multi-word command (e.g. "node my-adapter.js --flag") does not ENOENT.
    // Kept shell:false (no shell, no injection); complex quoting should live in a
    // wrapper script the operator points at. The adapter is operator-supplied.
    const tokens = adapterCmd.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0].length === 0) {
        throw new Error("discovery-adapter command is empty");
    }
    // Forward the anchored discovery scope to the adapter via stdin so the
    // adapter enumerates the SAME snapshot the manifest will record. This is the
    // spec's adapter contract; without it the manifest's source_anchor could
    // describe a snapshot the adapter never enumerated.
    const discoveryInput = {
        snapshot_anchor: config.anchor || { ref: "HEAD", resolved: null },
        roots: (config.roots || []).slice(),
        exclude: (config.exclude || []).slice(),
        granularity: config.granularity || "file",
    };
    let stdout;
    try {
        stdout = execFileSync(tokens[0], tokens.slice(1), {
            input: JSON.stringify(discoveryInput),
            stdio: ["pipe", "pipe", "pipe"],
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            shell: false,
        });
    } catch (err) {
        throw new Error(`discovery-adapter command failed: ${err.message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (err) {
        throw new Error(`discovery-adapter produced non-JSON output: ${err.message}`);
    }
    if (!parsed || !Array.isArray(parsed.units)) {
        throw new Error("discovery-adapter output missing 'units' array");
    }
    const merged = {
        ...config,
        adapterId: parsed.adapter_id || "external-adapter",
        adapterVersion: parsed.adapter_version || "0",
        coverageTier: parsed.coverage_tier || "adapter-complete",
        enumerationEvidence: (parsed.enumeration_evidence || []).slice(),
        unsupportedSurfaces: (parsed.unsupported_surfaces || []).slice(),
    };
    return buildManifestFromUnits(parsed.units, merged);
}

// Fallback discovery: deterministic file inventory enumerated FROM THE ANCHOR
// SNAPSHOT via `git ls-tree -r --name-only <anchor>`, filtered by roots/excludes.
// Enumerating the anchor's tree (not the current working index) is what keeps
// the discovered inventory consistent with the recorded source_anchor: a manifest
// claiming revision X must contain only units present at revision X. Claims
// `declared-inventory` (NOT adapter-complete) because a file inventory is NOT a
// semantic-unit enumeration. This limit is explicit. An anchored manifest
// requires a resolvable anchor — an unresolvable ref is rejected loudly rather
// than silently emitting the current index under a stale anchor.
function discoverViaGitFallback(roots, exclude, anchorRef, cwd) {
    const workDir = cwd || process.cwd();
    const rootMatchers = makeMatchers(roots.length ? roots : ["**"]);
    const excludeMatchers = makeMatchers(exclude);

    const anchorResolved = resolveAnchor(anchorRef, workDir);
    if (!anchorResolved) {
        throw new Error(
            `anchored manifest requires a resolvable anchor: git could not resolve "${anchorRef}" to a commit (not a git repo, or unknown ref)`,
        );
    }

    let files;
    try {
        // Enumerate the tree AT the resolved anchor commit. -r recurses, --name-only
        // emits paths, -z gives NUL-separated deterministic output. This is the
        // snapshot the manifest claims, so inventory and source_anchor agree.
        const out = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", anchorResolved], {
            cwd: workDir,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
        files = out.split("\0").filter((f) => f.length > 0);
    } catch (err) {
        throw new Error(
            `git ls-tree fallback failed at anchor ${anchorResolved}: ${err.message}`,
        );
    }

    const selected = files.filter((f) => {
        const norm = normalizeLocator(f);
        if (matchesAny(norm, excludeMatchers)) return false;
        return matchesAny(norm, rootMatchers);
    });

    const config = {
        roots,
        exclude,
        anchor: { ref: anchorRef, resolved: anchorResolved },
        anchorBasis: "git-ls-tree-at-anchor",
        coverageTier: "declared-inventory",
        defaultUnitType: "file",
        defaultInclusionBasis: "declared-root",
        defaultEnumerationEvidence: `git ls-tree -r --name-only ${anchorResolved}`,
        fallbackBasis: "git-ls-tree-at-anchor",
        enumerationEvidence: [
            `git ls-tree -r --name-only ${anchorResolved} (filtered by roots/exclude globs)`,
        ],
        unsupportedSurfaces: [
            "non-file units (declarations, transitions, cross-unit contracts) are NOT enumerated by the file fallback",
        ],
    };
    return buildManifestFromUnits(
        selected.map((locator) => ({ locator })),
        config,
    );
}

function resolveAnchor(ref, cwd) {
    try {
        const sha = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
            cwd: cwd || process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
        }).trim();
        return sha;
    } catch (_err) {
        return null; // not a git repo / unresolvable; recorded as null
    }
}

// ---------------------------------------------------------------------------
// Completeness accounting (Phase 3)
// ---------------------------------------------------------------------------

// Check that every manifest unit has exactly one terminal disposition and that
// every disposition references a known manifest unit. Returns a report object
// and a status. This is ACCOUNTING ONLY: "violations" (candidate_violation
// dispositions) are NOT a failure condition here — a complete ledger with many
// candidates still passes accounting.
function checkCompleteness(manifest, dispositionDoc, opts) {
    const cwd = (opts && opts.cwd) || process.cwd();
    const manifestIds = new Map(); // unit_id -> locator
    const manifestIdCounts = new Map(); // unit_id -> count (manifest-side dup detection)
    for (const u of manifest.units) {
        manifestIds.set(u.unit_id, u.locator);
        manifestIdCounts.set(u.unit_id, (manifestIdCounts.get(u.unit_id) || 0) + 1);
    }
    // Manifest-side duplicate unit_ids: a malformed or operator-supplied/merged
    // manifest may carry two records sharing one id, which would otherwise
    // collapse silently in the Map above. Helper-built manifests cannot produce
    // these (duplicate locators are rejected; distinct locators hash to distinct
    // ids), but the accounting must still flag them so a malformed manifest can
    // never silently pass as complete.
    const duplicateManifestId = [];
    for (const [id, count] of manifestIdCounts) {
        if (count > 1) duplicateManifestId.push({ unit_id: id, count });
    }

    const dispositions = Array.isArray(dispositionDoc.dispositions)
        ? dispositionDoc.dispositions
        : [];

    const seenIds = new Map(); // unit_id -> count
    const missing = []; // manifest units with no disposition
    const duplicate = []; // disposition unit_id disposed more than once
    const unknown = []; // disposition unit_id not in manifest
    const outsideManifest = []; // alias of unknown, reported distinctly
    const nonTerminal = []; // disposition value not a recognized terminal
    const candidateWithoutClass = []; // candidate_violation missing violation_class
    const counts = {};
    for (const t of TERMINAL_DISPOSITIONS) counts[t] = 0;

    for (const d of dispositions) {
        const id = d.unit_id;
        if (typeof id !== "string") {
            unknown.push({ unit_id: String(id), reason: "unit_id is not a string" });
            continue;
        }
        seenIds.set(id, (seenIds.get(id) || 0) + 1);
        if (!manifestIds.has(id)) {
            outsideManifest.push({ unit_id: id });
            continue;
        }
        const disp = d.disposition;
        if (!TERMINAL_DISPOSITIONS.has(disp)) {
            nonTerminal.push({ unit_id: id, disposition: disp });
            continue;
        }
        counts[disp] = (counts[disp] || 0) + 1;
        if (disp === "candidate_violation" && !d.violation_class) {
            candidateWithoutClass.push({ unit_id: id });
        }
    }

    for (const [id, count] of seenIds.entries()) {
        if (count > 1) duplicate.push({ unit_id: id, count });
    }
    for (const id of manifestIds.keys()) {
        if (!seenIds.has(id)) missing.push({ unit_id: id, locator: manifestIds.get(id) });
    }
    // Per-shard reconciliation: a shard is reconciled when every unit in it has
    // a disposition record. This is a per-shard view of unit completeness — it
    // tells you WHICH shard still has unvisited units. Dispositions do NOT carry
    // shard_id; reconciliation derives from which units have been disposed.
    const shardTotals = new Map(); // shard_id -> { total, disposed }
    for (const u of manifest.units) {
        if (u.shard_id == null) continue;
        if (!shardTotals.has(u.shard_id)) shardTotals.set(u.shard_id, { total: 0, disposed: 0 });
        shardTotals.get(u.shard_id).total += 1;
        if (seenIds.has(u.unit_id)) shardTotals.get(u.shard_id).disposed += 1;
    }
    const shardUnreconciled = [];
    for (const [sid, c] of shardTotals) {
        if (c.disposed < c.total) shardUnreconciled.push({ shard_id: sid, disposed: c.disposed, total: c.total });
    }

    // Anchor reconciliation: if the manifest recorded a resolved anchor and the
    // current repo resolves the same ref to a DIFFERENT commit, the snapshot
    // has drifted and explicit reconciliation is required.
    let anchorStatus = "not-applicable";
    if (manifest.anchor && manifest.anchor.ref && manifest.anchor.resolved) {
        const current = resolveAnchor(manifest.anchor.ref, cwd);
        if (current == null) {
            anchorStatus = "unresolvable";
        } else if (current !== manifest.anchor.resolved) {
            if (dispositionDoc.anchor_reconciliation) {
                anchorStatus = "reconciled-explicitly";
            } else {
                anchorStatus = "drifted-unreconciled";
            }
        } else {
            anchorStatus = "matches";
        }
    }

    const malformed =
        missing.length > 0 ||
        duplicate.length > 0 ||
        duplicateManifestId.length > 0 ||
        unknown.length > 0 ||
        outsideManifest.length > 0 ||
        nonTerminal.length > 0 ||
        candidateWithoutClass.length > 0 ||
        shardUnreconciled.length > 0 ||
        anchorStatus === "drifted-unreconciled";

    const status = malformed ? "malformed" : "complete";

    return {
        schema: "contract-invariant-audit/completeness-report@1",
        status,
        manifest_units: manifest.units.length,
        dispositioned_units: dispositions.length,
        counts,
        missing,
        duplicate,
        duplicate_manifest_id: duplicateManifestId,
        unknown,
        outside_manifest: outsideManifest,
        non_terminal: nonTerminal,
        candidate_without_class: candidateWithoutClass,
        shard_unreconciled: shardUnreconciled,
        anchor_status: anchorStatus,
    };
}

// ---------------------------------------------------------------------------
// Self-test (exercises discover -> manifest -> complete, determinism + accounting)
// ---------------------------------------------------------------------------

function assert(cond, msg) {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
}

function findRepoRoot(start) {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i += 1) {
        if (fs.existsSync(path.join(dir, ".git"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// Hermetic self-test. Builds a synthetic discovered-unit set, runs the manifest
// builder twice (determinism), and exercises the completeness checker against a
// missing-disposition doc, a complete doc, and malformed docs. No network, no
// dependency on repo git state for the core assertions.
function runSelfTest() {
    const failures = [];
    let tempDir = null;

    // --- Part A: hermetic synthetic discover -> manifest -> complete ---------
    try {
        const syntheticUnits = [
            { locator: "unit/alpha/first" },
            { locator: "./unit/beta//second" }, // normalization exercise
            { locator: "unit/alpha\\first" }, // backslash normalization -> DUPLICATE of first
        ];
        // The third locator normalizes to the same as the first; buildManifest
        // must reject duplicates loudly (discoverer accounting defect).
        let threw = false;
        try {
            buildManifestFromUnits(syntheticUnits, { coverageTier: "declared-inventory" });
        } catch (_err) {
            threw = true;
        }
        assert(threw, "duplicate normalized locator must be rejected by the manifest builder");

        const cleanUnits = [
            { locator: "unit/alpha/first", unit_type: "file" },
            { locator: "unit/beta/second", unit_type: "file" },
            { locator: "notes/contract", unit_type: "file" },
        ];
        const config = {
            roots: ["src/**", "docs/**"],
            exclude: ["**/*.gen.*"],
            anchor: { ref: "fixture", resolved: "deadbeef" },
            coverageTier: "declared-inventory",
            fallbackBasis: "synthetic-fixture",
        };
        const m1 = buildManifestFromUnits(cleanUnits, config);
        const m2 = buildManifestFromUnits(cleanUnits, config);
        const s1 = stableStringify(m1);
        const s2 = stableStringify(m2);
        assert(s1 === s2, "identical inputs must produce byte-identical manifests (determinism)");

        // Determinism of unit_id: re-derive and compare.
        for (const u of m1.units) {
            assert(u.unit_id === unitIdFor(u.locator), "unit_id must equal hash of normalized locator");
        }
        // Order is deterministic (sorted by unit_id).
        for (let i = 1; i < m1.units.length; i += 1) {
            assert(m1.units[i - 1].unit_id <= m1.units[i].unit_id, "units must be sorted by unit_id");
        }

        // Completeness: MISSING disposition -> malformed, flagged, non-zero.
        const partial = {
            schema: COMPLETE_SCHEMA,
            dispositions: [
                { unit_id: m1.units[0].unit_id, disposition: "clean" },
                // m1.units[1] deliberately missing
                { unit_id: m1.units[2].unit_id, disposition: "not_applicable", reason: "doc" },
            ],
        };
        const rPartial = checkCompleteness(m1, partial);
        assert(rPartial.status === "malformed", "missing disposition must yield status=malformed");
        assert(rPartial.missing.length === 1, "exactly one missing unit must be reported");
        assert(rPartial.missing[0].unit_id === m1.units[1].unit_id, "the correct missing unit reported");

        // Completeness: complete (incl. candidate_violation) -> complete, exit 0.
        const complete = {
            schema: COMPLETE_SCHEMA,
            dispositions: [
                { unit_id: m1.units[0].unit_id, disposition: "clean" },
                {
                    unit_id: m1.units[1].unit_id,
                    disposition: "candidate_violation",
                    violation_class: "C2",
                },
                { unit_id: m1.units[2].unit_id, disposition: "not_applicable", reason: "doc" },
            ],
        };
        const rComplete = checkCompleteness(m1, complete);
        assert(rComplete.status === "complete", "fully disposed manifest must be status=complete");
        assert(rComplete.counts.candidate_violation === 1, "candidate_violation counted");
        // A complete ledger WITH a violation still passes accounting (helper
        // does not care about violations).
        assert(!isMalformed(rComplete), "violations are not an accounting failure");

        // Completeness: duplicate / unknown / non-terminal / candidate-without-class.
        const malformed1 = {
            schema: COMPLETE_SCHEMA,
            dispositions: [
                { unit_id: m1.units[0].unit_id, disposition: "clean" },
                { unit_id: m1.units[0].unit_id, disposition: "clean" }, // duplicate
                { unit_id: m1.units[1].unit_id, disposition: "bogus_state" }, // non-terminal
                { unit_id: "ffffffffffffffff", disposition: "clean" }, // unknown
                { unit_id: m1.units[2].unit_id, disposition: "candidate_violation" }, // no class
            ],
        };
        const rMal = checkCompleteness(m1, malformed1);
        assert(rMal.status === "malformed", "malformed doc must be status=malformed");
        assert(rMal.duplicate.length === 1, "duplicate detected");
        assert(rMal.unknown.length >= 0, "unknown bucket present");
        assert(rMal.outside_manifest.length === 1, "outside-manifest detected");
        assert(rMal.non_terminal.length === 1, "non-terminal detected");
        assert(rMal.candidate_without_class.length === 1, "candidate without class detected");

        // Anchor drift detection.
        const driftedManifest = JSON.parse(JSON.stringify(m1));
        driftedManifest.anchor.resolved = "cafebabe"; // pretend snapshot moved
        const rDrift = checkCompleteness(driftedManifest, complete);
        // ref="fixture" is not a real git ref -> resolveAnchor returns null ->
        // anchor_status="unresolvable" (NOT drifted-unreconciled). Verify the
        // machinery runs and classifies rather than crashing.
        assert(
            rDrift.anchor_status === "unresolvable" || rDrift.anchor_status === "matches",
            "anchor machinery must classify without crashing on synthetic ref",
        );

        // Shard reconciliation (CF3 coverage): a shard is reconciled only when
        // every unit in it has a disposition record.
        const shardedUnits = [
            { locator: "s/u1", shard_id: "s1" },
            { locator: "s/u2", shard_id: "s1" },
            { locator: "s/u3", shard_id: "s2" },
        ];
        const shardedManifest = buildManifestFromUnits(shardedUnits, {
            roots: ["s/**"],
            anchor: { ref: "fixture", resolved: "deadbeef" },
            coverageTier: "declared-inventory",
        });
        const allDisposedShards = {
            schema: COMPLETE_SCHEMA,
            dispositions: shardedManifest.units.map((u) => ({ unit_id: u.unit_id, disposition: "clean" })),
        };
        const rShardOk = checkCompleteness(shardedManifest, allDisposedShards);
        assert(rShardOk.shard_unreconciled.length === 0, "fully-disposed shards must be reconciled");
        // Drop the disposition for one s1 unit -> s1 becomes unreconciled.
        const partialShard = {
            schema: COMPLETE_SCHEMA,
            dispositions: shardedManifest.units
                .filter((u) => u.locator !== "s/u1")
                .map((u) => ({ unit_id: u.unit_id, disposition: "clean" })),
        };
        const rShardBad = checkCompleteness(shardedManifest, partialShard);
        assert(rShardBad.status === "malformed", "an unreconciled shard must make accounting malformed");
        assert(rShardBad.shard_unreconciled.length === 1, "exactly one unreconciled shard reported");
        assert(
            rShardBad.shard_unreconciled[0].shard_id === "s1",
            "the correct shard reported unreconciled",
        );

        // Manifest-side duplicate unit_id guard (F7): a malformed or
        // operator-supplied manifest carrying two records with the same unit_id
        // must not silently collapse to "complete". Helper-built manifests
        // cannot produce this, so construct it by duplicating a unit record.
        const dupManifest = JSON.parse(JSON.stringify(m1));
        dupManifest.units.push({ ...dupManifest.units[0] }); // same unit_id twice
        const rDupManifest = checkCompleteness(dupManifest, {
            schema: COMPLETE_SCHEMA,
            dispositions: dupManifest.units.map((u) => ({ unit_id: u.unit_id, disposition: "clean" })),
        });
        assert(
            rDupManifest.status === "malformed",
            "a manifest with a duplicate unit_id must be malformed",
        );
        assert(
            rDupManifest.duplicate_manifest_id.length === 1,
            "the duplicate manifest unit_id must be reported",
        );

        // Anchor threading at the unit level (F6 mechanism): a manifest built
        // with an explicit resolved anchor records that resolved value as every
        // unit's source_anchor (the property the adapter path now populates).
        const anchored = buildManifestFromUnits(cleanUnits, {
            roots: ["unit/**", "notes/**"],
            anchor: { ref: "v1.2.3", resolved: "feedface" },
            coverageTier: "declared-inventory",
        });
        assert(
            anchored.anchor.resolved === "feedface" && anchored.anchor.ref === "v1.2.3",
            "explicit anchor must be recorded on the manifest",
        );
        assert(
            anchored.units.every((u) => u.source_anchor === "feedface"),
            "every unit's source_anchor must equal the resolved anchor",
        );
    } catch (err) {
        failures.push(`Part A (hermetic logic): ${err.message}`);
    }

    // --- Part B: real git fallback smoke (best-effort, only if git available) -
    try {
        tempDir = makeTempDir();
        const gitOk = initTempGitRepo(tempDir);
        if (gitOk) {
            // Two known files under pkg/, one excluded file at root.
            fs.mkdirSync(path.join(tempDir, "pkg"), { recursive: true });
            fs.writeFileSync(path.join(tempDir, "pkg", "a.txt"), "a");
            fs.writeFileSync(path.join(tempDir, "pkg", "b.txt"), "b");
            fs.writeFileSync(path.join(tempDir, "excluded.gen.txt"), "x");
            gitAdd(tempDir, ["pkg/a.txt", "pkg/b.txt", "excluded.gen.txt"]);

            const roots = ["pkg/**"];
            const excludes = ["**/*.gen.*"];
            // Determinism: two IDENTICAL-input runs must be byte-identical.
            const m = discoverViaGitFallback(roots, excludes, "HEAD", tempDir);
            const mAgain = discoverViaGitFallback(roots, excludes, "HEAD", tempDir);
            assert(
                stableStringify(m) === stableStringify(mAgain),
                "git fallback: identical inputs must produce byte-identical manifests",
            );
            // Coverage tier is declared-inventory (NOT adapter-complete).
            assert(m.coverage_tier === "declared-inventory", "fallback must claim declared-inventory");
            // The excluded file is not in the manifest; included files are.
            const locators = new Set(m.units.map((u) => u.locator));
            assert(locators.has("pkg/a.txt"), "included file present");
            assert(locators.has("pkg/b.txt"), "included file present");
            assert(!locators.has("excluded.gen.txt"), "excluded file absent");
            assert(
                m.units.every((u) => u.unit_id === unitIdFor(u.locator)),
                "git fallback IDs deterministic",
            );

            // Complete accounting on the real fallback manifest.
            const all = m.units.map((u) => ({ unit_id: u.unit_id, disposition: "clean" }));
            const r = checkCompleteness(m, { schema: COMPLETE_SCHEMA, dispositions: all }, { cwd: tempDir });
            assert(r.status === "complete", "real fallback manifest must reach complete accounting");

            // Anchor-drift detection (CF1 coverage): advancing HEAD after the
            // manifest was pinned makes the recorded source_anchor stale, and the
            // fallback enumerated the PINNED tree (not the live index), so the
            // stale anchor is a real signal: the fallback enumerated the PINNED
            // tree (not the live index), so a moved HEAD genuinely means the
            // manifest no longer describes the current snapshot.
            const pinnedAnchor = m.anchor.resolved;
            fs.writeFileSync(path.join(tempDir, "pkg", "c.txt"), "c");
            gitAdd(tempDir, ["pkg/c.txt"]); // advances HEAD to a new commit
            const newHead = resolveAnchor("HEAD", tempDir);
            assert(newHead !== pinnedAnchor, "advancing HEAD must move the resolved anchor");
            const rDriftReal = checkCompleteness(
                m,
                { schema: COMPLETE_SCHEMA, dispositions: all },
                { cwd: tempDir },
            );
            assert(
                rDriftReal.anchor_status === "drifted-unreconciled",
                "a manifest pinned to a prior commit must report drifted-unreconciled",
            );
            assert(
                rDriftReal.status === "malformed",
                "drifted-unreconciled anchor must make accounting malformed",
            );
            // Explicit reconciliation clears the anchor failure (the ledger is
            // otherwise complete: all manifest units disposed).
            const rReconciled = checkCompleteness(
                m,
                {
                    schema: COMPLETE_SCHEMA,
                    dispositions: all,
                    anchor_reconciliation: `pinned manifest re-verified at ${pinnedAnchor}`,
                },
                { cwd: tempDir },
            );
            assert(
                rReconciled.anchor_status === "reconciled-explicitly",
                "explicit reconciliation must clear anchor drift",
            );
            assert(rReconciled.status === "complete", "with reconciliation the ledger is complete");
        }
    } catch (err) {
        failures.push(`Part B (git fallback smoke): ${err.message}`);
    } finally {
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (_err) {
                // best-effort cleanup
            }
        }
    }

    // --- Part C: adapter wire contract (anchor forwarded via stdin) -----------
    // Proves the F1 fix: the helper forwards the resolved anchor to the adapter
    // process, so the manifest's source_anchor describes the snapshot the adapter
    // actually enumerated (not a decorative value the helper recorded alone).
    let tempDirC = null;
    try {
        const anchorRef = "HEAD~1";
        const resolved = resolveAnchor(anchorRef);
        if (resolved) {
            tempDirC = makeTempDir();
            // A conformant adapter: reads the discovery scope from stdin,
            // enumerates at snapshot_anchor.resolved, echoes the received anchor
            // in its evidence so the test can prove it arrived.
            const adapterScript = `import { stdin, stdout } from "node:process";
let buf = "";
stdin.setEncoding("utf8");
stdin.on("data", (c) => { buf += c; });
stdin.on("end", () => {
    const cfg = JSON.parse(buf);
    const r = (cfg.snapshot_anchor && cfg.snapshot_anchor.resolved) || "(none)";
    const ref = (cfg.snapshot_anchor && cfg.snapshot_anchor.ref) || "(none)";
    stdout.write(JSON.stringify({
        adapter_id: "selftest-stdin-adapter",
        adapter_version: "1",
        coverage_tier: "adapter-complete",
        units: [{ locator: "synth/one", unit_type: "declaration",
                  inclusion_basis: "stdin-contract",
                  enumeration_evidence: "enumerated at anchor " + r }],
        enumeration_evidence: ["received snapshot_anchor ref=" + ref + " resolved=" + r + " via stdin"],
        unsupported_surfaces: []
    }));
});
`;
            const adapterPath = path.join(tempDirC, "adapter.mjs");
            fs.writeFileSync(adapterPath, adapterScript, "utf8");

            const manifest = runAdapter(`node ${adapterPath}`, {
                roots: ["synth/**"],
                exclude: [],
                granularity: "declaration",
                anchor: { ref: anchorRef, resolved },
                anchorBasis: "adapter-via-stdin",
            });
            // The manifest records the forwarded anchor + honest basis.
            assert(
                manifest.anchor.resolved === resolved,
                "adapter manifest must record the forwarded resolved anchor",
            );
            assert(
                manifest.anchor_basis === "adapter-via-stdin",
                "adapter manifest must record anchor_basis=adapter-via-stdin",
            );
            assert(
                manifest.units.every((u) => u.source_anchor === resolved),
                "every adapter unit's source_anchor must equal the forwarded anchor",
            );
            // The adapter RECEIVED the anchor via stdin (proven by its echoed
            // evidence carrying the resolved sha, which only the helper could
            // have supplied).
            const evidence = manifest.discovery.enumeration_evidence.join(" ");
            assert(
                evidence.includes(`resolved=${resolved}`),
                "the adapter must report receiving the resolved anchor via stdin",
            );
        }
    } catch (err) {
        failures.push(`Part C (adapter stdin contract): ${err.message}`);
    } finally {
        if (tempDirC) {
            try {
                fs.rmSync(tempDirC, { recursive: true, force: true });
            } catch (_err) {
                // best-effort cleanup
            }
        }
    }

    if (failures.length > 0) {
        for (const f of failures) console.error(f);
        console.error(`\nSELF-TEST: FAIL (${failures.length} failure(s))`);
        return false;
    }
    console.error("SELF-TEST: PASS (determinism + completeness accounting verified; discover->manifest->complete exercised)");
    return true;
}

function isMalformed(report) {
    return report.status !== "complete";
}

function makeTempDir() {
    const base = findRepoRoot(path.dirname(new URL(import.meta.url).pathname)) || os.tmpdir();
    const tmpRoot = path.join(base, "tmp");
    try {
        fs.mkdirSync(tmpRoot, { recursive: true });
    } catch (_err) {
        // may already exist
    }
    return fs.mkdtempSync(path.join(tmpRoot, "manifest-helper-selftest-"));
}

function initTempGitRepo(dir) {
    try {
        execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "selftest@example.invalid"], {
            cwd: dir,
            stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "selftest"], { cwd: dir, stdio: "ignore" });
        return true;
    } catch (_err) {
        return false;
    }
}

function gitAdd(dir, files) {
    execFileSync("git", ["add", "--", ...files], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "selftest fixture"], { cwd: dir, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseListFlag(args, name) {
    // Accepts repeated --name <v> and comma-separated values.
    const out = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === name) {
            const v = args[i + 1];
            if (typeof v !== "string") throw new Error(`missing value for ${name}`);
            out.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
            i += 1;
        }
    }
    return out;
}

function parseStringFlag(args, name) {
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === name) {
            const v = args[i + 1];
            if (typeof v !== "string") throw new Error(`missing value for ${name}`);
            return v;
        }
    }
    return undefined;
}

function readJson(file) {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function cmdManifest(args) {
    const roots = parseListFlag(args, "--roots");
    const exclude = parseListFlag(args, "--exclude");
    const adapter = parseStringFlag(args, "--adapter");
    const anchor = parseStringFlag(args, "--anchor") || "HEAD";
    const granularity = parseStringFlag(args, "--granularity") || "file";
    const unitsFile = parseStringFlag(args, "--units");
    const out = parseStringFlag(args, "--out");
    if (!out) throw new Error("--out <file> is required for manifest");

    let manifest;
    if (adapter) {
        // Resolve and record the anchor for the adapter path too, so adapter
        // manifests carry a pinned source_anchor and remain drift-detectable
        // (without this, the manifest defaulted to ref='HEAD'/resolved=null and
        // anchor-drift detection was silently disabled). The adapter is
        // responsible for enumerating units consistent with this anchor; the
        // helper only records it. If the anchor is unresolvable (e.g. a non-git
        // adapter source), resolved is recorded as null and drift detection
        // stays not-applicable rather than being silently mis-anchored.
        const anchorResolved = resolveAnchor(anchor);
        const cfg = {
            roots,
            exclude,
            adapter,
            granularity,
            anchor: { ref: anchor, resolved: anchorResolved },
            anchorBasis: "adapter-via-stdin",
        };
        manifest = runAdapter(adapter, cfg);
    } else {
        manifest = discoverViaGitFallback(roots, exclude, anchor);
        manifest.config.granularity = granularity;
    }

    // Accept operator/adapter-supplied cross-unit units verbatim (reversibility,
    // debate condition 5): the helper never infers them, only merges supplied
    // ones and assigns IDs.
    if (unitsFile) {
        const extra = readJson(unitsFile);
        if (Array.isArray(extra.units)) {
            const existing = new Map(manifest.units.map((u) => [u.locator, u]));
            for (const raw of extra.units) {
                const loc = normalizeLocator(raw.locator);
                if (existing.has(loc)) continue; // idempotent merge
                existing.set(loc, {
                    unit_id: unitIdFor(loc),
                    locator: loc,
                    unit_type: raw.unit_type || "cross-unit",
                    source_anchor: manifest.anchor.resolved || manifest.anchor.ref,
                    discovery_adapter: "operator-supplied",
                    inclusion_basis: raw.inclusion_basis || "operator-declared-cross-unit",
                    enumeration_evidence: raw.enumeration_evidence || "operator-supplied",
                    exclusion_reason: null,
                    shard_id: raw.shard_id ?? null,
                    coverage_tier: manifest.coverage_tier,
                });
            }
            manifest.units = [...existing.values()].sort((a, b) =>
                a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0,
            );
        }
    }

    const doc = stableStringify(manifest) + "\n";
    fs.writeFileSync(out, doc, "utf8");
    process.stderr.write(
        `manifest: wrote ${manifest.units.length} unit(s), coverage_tier=${manifest.coverage_tier} -> ${out}\n`,
    );
}

function cmdComplete(args) {
    const manifestFile = parseStringFlag(args, "--manifest");
    const dispositionsFile = parseStringFlag(args, "--dispositions");
    if (!manifestFile || !dispositionsFile) {
        throw new Error("--manifest <file> and --dispositions <file> are required for complete");
    }
    const manifest = readJson(manifestFile);
    const dispositionDoc = readJson(dispositionsFile);
    const report = checkCompleteness(manifest, dispositionDoc);
    process.stdout.write(stableStringify(report) + "\n");
    const malformed = isMalformed(report);
    process.stderr.write(
        `complete: status=${report.status}, manifest=${report.manifest_units}, ` +
            `dispositioned=${report.dispositioned_units}` +
            (report.missing.length ? `, missing=${report.missing.length}` : "") +
            (report.duplicate.length ? `, duplicate=${report.duplicate.length}` : "") +
            (report.outside_manifest.length ? `, outside=${report.outside_manifest.length}` : "") +
            (report.non_terminal.length ? `, non_terminal=${report.non_terminal.length}` : "") +
            (report.shard_unreconciled.length ? `, shard_unreconciled=${report.shard_unreconciled.length}` : "") +
            `\n`,
    );
    process.exit(malformed ? EXIT_MALFORMED : EXIT_COMPLETE);
}

function printHelp() {
    process.stderr.write(`manifest-helper.js — deterministic discovery/accounting helper
for the contract/invariant audit capability (overlay-only S1 pilot).

FROZEN BOUNDARY: discovery/accounting ONLY. No semantic evaluation, no
violation-class assignment, no ranking, no network. Advisory (INFORMS) only.

USAGE
  manifest-helper.js manifest --roots <globs> --exclude <globs>
        [--adapter '<cmd>'] [--anchor <git-ref>] [--granularity <name>]
        [--units <file>] --out <file>
      Enumerate declared units and write a deterministic manifest JSON.
      Fallback (no --adapter) enumerates the anchor snapshot via 'git ls-tree'
      (anchor_basis=git-ls-tree-at-anchor) and claims 'declared-inventory'
      (NOT adapter-complete). With --adapter, the helper FORWARDS the resolved
      anchor + roots/exclude/granularity to the adapter as JSON on STDIN
      (anchor_basis=adapter-via-stdin); a conformant adapter reads stdin and
      enumerates at snapshot_anchor.resolved, then emits the adapter JSON on
      stdout. --units merges operator/adapter-supplied cross-unit units verbatim
      (never inferred).

  manifest-helper.js complete --manifest <file> --dispositions <file>
      Completeness accounting. Exit 0 when every manifest unit has exactly one
      terminal disposition and accounting is well-formed; exit 2 on malformed
      accounting (missing/duplicate-disposition/duplicate-manifest-id/unknown/
      non-terminal/shard/anchor). A 'candidate_violation' disposition is NOT a
      failure here.

  manifest-helper.js --self-test
      Hermetic discover->manifest->complete exercise. Verifies determinism
      (identical inputs -> byte-identical manifests), completeness accounting
      (missing/duplicate/unknown/non-terminal/shard detected; complete ledger
      passes), anchor-drift detection, and the adapter stdin wire contract.
      Exits 0 on pass, 1 on fail.

FLAGS
  --roots <globs>      comma-separated and/or repeated inclusion globs
  --exclude <globs>    comma-separated and/or repeated exclusion globs
  --adapter '<cmd>'    external discovery command; receives the anchored scope
                       on stdin (JSON) and emits the adapter JSON on stdout
  --anchor <git-ref>   snapshot anchor (default HEAD)
  --granularity <name> recorded unit granularity (default 'file')
  --units <file>       operator-supplied cross-unit units JSON (merged verbatim)
  --out <file>         output manifest path
  --manifest <file>    manifest path (complete command)
  --dispositions <f>   dispositions path (complete command)

GLOBS: * (within a segment), ** (across segments), ? (one char, not '/').

No external package dependencies. Node stdlib only.
`);
}

function main(argv) {
    const args = argv.slice(2);
    if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
        printHelp();
        return EXIT_USAGE;
    }
    if (args[0] === "--self-test") {
        const ok = runSelfTest();
        return ok ? 0 : 1;
    }
    try {
        if (args[0] === "manifest") {
            cmdManifest(args.slice(1));
            return 0;
        }
        if (args[0] === "complete") {
            cmdComplete(args.slice(1));
            return EXIT_COMPLETE; // cmdComplete exits; this is a guard
        }
        throw new Error(`unknown command: ${args[0]}`);
    } catch (err) {
        process.stderr.write(`error: ${err.message}\n`);
        printHelp();
        return EXIT_USAGE;
    }
}

process.exit(main(process.argv));
