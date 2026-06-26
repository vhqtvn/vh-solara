import fs from "fs";
import path from "path";

import { COMMANDS as REPO_COMMANDS_CONFIG } from "../repo-configs/allowed-commands.js";

const DEFAULT_CONFIG_PATH = "opencode.jsonc";

// Maintainer contract:
// - This script is the single source of truth for `permission.bash` and
//   `permission.task` blocks rendered into `opencode.jsonc`, plus hidden
//   leaf agent blocks for declared clusters.
// - The active agent roster is DATA-DRIVEN: it is resolved at runtime from the
//   project's `vh-harness-profile.yml` (`overlays[]` selects overlay packs;
//   `features` carries feature-flags) merged onto the always-on CORE roster.
//   Overlay packs self-describe their permission contribution in per-pack
//   `permission-pack.jsonc` files that the seam installer materializes to
//   .opencode/sys-scripts/permission-packs/ for the ACTIVE packs; this script
//   reads that directory DYNAMICALLY (never by hardcoded pack name). See
//   loadPermissionPacks() and resolveActiveRules().
// - Update command-level decisions in `COMMANDS` and the CORE_*_RULES maps.
// - To add an overlay pack: ship a pack dir under templates/overlays/ with its
//   own permission-pack.jsonc; no edit to this file is required.
// - Declare clusters in `CLUSTER_DEFS`; leaf rules, hidden agent blocks, and
//   leaf .md files are auto-generated at runtime.
// - After edits, run:
//   `vh-agent-harness exec node .opencode/sys-scripts/update-opencode-config.js`
// - Avoid hand-editing rendered `permission.bash` / `permission.task` blocks in
//   `opencode.jsonc`; they will be overwritten by this script.

const COMMANDS = {
    ...REPO_COMMANDS_CONFIG,
    custom: {},
};

// ─── Cluster definitions ──────────────────────────────────────────────
//
// Each entry defines a cluster with one visible orchestrator and N hidden
// leaves named `{orchestrator}-{a..z}`.  The script auto-generates:
//
//   - LOCATION_RULES entries for each leaf (from `leafBaseRule`)
//   - TASK_RULES entries for each leaf (`{ "*": "deny" }`)
//   - Orchestrator TASK_RULES task allowlist (all leaves auto-allowed)
//   - Hidden leaf agent blocks in `opencode.jsonc`
//   - Leaf `.md` prompt files (cloned from the `-a` template)
//
// To add a leaf: increment `leafCount` and re-run the script.
// To remove a leaf: decrement `leafCount`, delete the stale `-X.md` file,
//   and re-run.  The script will remove the stale block from opencode.jsonc.

const CLUSTER_DEFS = {
    "commit-reviewer": {
        leafCount: 4,
        leafBaseRule: {
            wildcard: "deny",
            readonly: "allow",
            git_readonly: "allow",
            gate: "deny",
            devSh: "allow",
        },
        temperature: 0.1,
    },
};

// ─── CORE agent roster (always-on) ─────────────────────────────────────
//
// CORE_LOCATION_RULES / CORE_TASK_RULES hold ONLY agents the harness ships in
// the core pack. Overlay-pack agents are declared in each pack's own
// permission-pack.jsonc (see loadPermissionPacks) and merged in by
// resolveActiveRules() only when their pack is materialized under
// .opencode/sys-scripts/permission-packs/ (i.e. listed as active in
// vh-harness-profile.yml `overlays: [...]`).
//
// Cross-references from core orchestrators (build / coordination /
// project-coordinator) to overlay agents are NOT hand-written here either —
// resolveActiveRules() injects them from each active pack's `delegateFrom`.

const CORE_LOCATION_RULES = {
    default: {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "allow",
    },
    plan: {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "ask",
    },
    build: {
        wildcard: "ask",
        readonly: "allow",
        git_readonly: "allow",
        devSh: "allow",
    },
    coordination: {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        devSh: "allow",
    },
    planner: {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "allow",
    },
    researcher: {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "allow",
    },
    "project-coordinator": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        devSh: "allow",
    },
    debate: {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "deny",
    },
    "debate-proposer": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "deny",
    },
    "debate-critic": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "deny",
    },
    "debate-synth": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "deny",
    },
    "solution-brief": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "deny",
    },
    "repo-explorer": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "ask",
    },
    "docs-steward": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        devSh: "ask",
    },
    "commit-message": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "allow",
    },
    "commit-reviewer": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "allow",
    },
    committer: {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "allow",
        devSh: "deny",
    },
    "ship-review": {
        wildcard: "deny",
        readonly: "allow",
        git_readonly: "allow",
        gate: "deny",
        devSh: "allow",
    },
};

const CORE_TASK_RULES = {
    plan: {
        "*": "deny",
    },
    build: {
        "*": "deny",
        "commit-message": "allow",
        "project-coordinator": "allow",
        planner: "allow",
        researcher: "allow",
        "repo-explorer": "allow",
        "commit-reviewer": "allow",
        "ship-review": "allow",
        committer: "allow",
        "docs-steward": "allow",
        debate: "allow",
        "solution-brief": "allow",
    },
    coordination: {
        "*": "deny",
        build: "allow",
        "project-coordinator": "allow",
        "commit-message": "allow",
        planner: "allow",
        researcher: "allow",
        "repo-explorer": "allow",
        "commit-reviewer": "allow",
        "ship-review": "allow",
        committer: "allow",
        debate: "allow",
        "solution-brief": "allow",
    },
    planner: {
        "*": "deny",
    },
    researcher: {
        "*": "deny",
    },
    "project-coordinator": {
        "*": "deny",
        build: "allow",
        "commit-message": "allow",
        planner: "allow",
        researcher: "allow",
        "repo-explorer": "allow",
        "commit-reviewer": "allow",
        "ship-review": "allow",
        committer: "allow",
        debate: "allow",
        "solution-brief": "allow",
    },
    debate: {
        "*": "deny",
        "debate-proposer": "allow",
        "debate-critic": "allow",
        "debate-synth": "allow",
    },
    "debate-proposer": {
        "*": "deny",
    },
    "debate-critic": {
        "*": "deny",
    },
    "debate-synth": {
        "*": "deny",
    },
    "solution-brief": {
        "*": "deny",
        researcher: "allow",
        debate: "allow",
        planner: "allow",
    },
    "repo-explorer": {
        "*": "deny",
    },
    "docs-steward": {
        "*": "deny",
        committer: "allow",
    },
    "commit-message": {
        "*": "deny",
        "commit-reviewer": "allow",
    },
    "commit-reviewer": {
        "*": "deny",
    },
    committer: {
        "*": "deny",
        "commit-reviewer": "allow",
    },
    "ship-review": {
        "*": "deny",
    },
};

// ─── Overlay packs (selectable via vh-harness-profile.yml `overlays: [...]`) ─
//
// Overlay packs self-describe their permission contribution in a per-pack
// `permission-pack.jsonc` that the seam installer materializes to
//   .opencode/sys-scripts/permission-packs/<pack>.jsonc
// for every ACTIVE pack (inactive packs leave no trace). The roster resolver
// reads that directory DYNAMICALLY (by directory listing — never by hardcoded
// pack name), so the harness core never names any overlay pack or any
// domain-specific agent. Adding a new pack is purely additive: ship a pack dir
// under templates/overlays/ with its own permission-pack.jsonc and the resolver
// picks it up automatically once a project lists it in vh-harness-profile.yml.
//
// Per-agent fields in a permission-pack.jsonc:
//   location     -> permission.bash location decisions for the agent
//   task         -> permission.task allowlist for the agent
//   gateExempt   -> true registers the agent as a committer-delegator that must
//                   omit a `gate` decision (see GATE_EXEMPT_AGENTS)
//   delegateFrom -> core orchestrators whose task allowlist gets an auto-
//                   injected allow entry for this agent while the pack is active
const PERMISSION_PACKS_DIR = ".opencode/sys-scripts/permission-packs";

// stripJsoncComments removes `// ...` line comments and `/* ... */` block
// comments from a JSONC source so it can be fed to JSON.parse. It is a small
// tolerant stripper (not a full lexer): it ignores comment markers inside double
// quoted strings. Sufficient for the hand-authored permission-pack descriptors.
function stripJsoncComments(src) {
    let out = "";
    let i = 0;
    let inStr = false;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (inStr) {
            if (c === "\\") {
                out += c + (src[i + 1] ?? "");
                i += 2;
                continue;
            }
            if (c === '"') {
                inStr = false;
            }
            out += c;
            i += 1;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") {
            // line comment: skip to end of line
            const nl = src.indexOf("\n", i);
            if (nl === -1) break;
            i = nl + 1;
            continue;
        }
        if (c === "/" && next === "*") {
            // block comment: skip to closing */
            const end = src.indexOf("*/", i + 2);
            if (end === -1) break;
            i = end + 2;
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

// loadPermissionPacks reads every `<pack>.jsonc` in PERMISSION_PACKS_DIR and
// returns { packName: { agents: { ... } } }. The directory holds exactly the
// ACTIVE packs (the seam installer materializes only those), so every loaded
// descriptor applies. A missing directory (core-only install, no active
// overlays) yields {} and the resolver is a no-op for overlays. Malformed files
// are reported and skipped (never throw) so a single bad pack cannot brick the
// whole permission render.
function loadPermissionPacks() {
    const packs = {};
    if (!fs.existsSync(PERMISSION_PACKS_DIR)) {
        return packs;
    }
    let entries;
    try {
        entries = fs.readdirSync(PERMISSION_PACKS_DIR);
    } catch (e) {
        console.log(`  (could not read ${PERMISSION_PACKS_DIR}: ${e.message})`);
        return packs;
    }
    for (const entry of entries) {
        if (!entry.endsWith(".jsonc") && !entry.endsWith(".json")) continue;
        const packName = entry.replace(/\.(jsonc|json)$/, "");
        const fileRel = `${PERMISSION_PACKS_DIR}/${entry}`;
        try {
            const raw = fs.readFileSync(fileRel, "utf8");
            const parsed = JSON.parse(stripJsoncComments(raw));
            if (!parsed || !parsed.agents || typeof parsed.agents !== "object") {
                console.log(`  (permission-pack ${entry}: no "agents" map — skipped)`);
                continue;
            }
            packs[packName] = parsed;
        } catch (e) {
            console.log(`  (permission-pack ${entry}: parse failed — skipped: ${e.message})`);
        }
    }
    return packs;
}

// The resolved rule maps. Assigned by resolveActiveRules() in main() before
// expandClusterRules() and validateRules() run. Kept as `let` so the existing
// helpers (which close over these names) read the resolved set at call-time.
let LOCATION_RULES = {};
let TASK_RULES = {};

// Agents that can delegate to the committer subagent must NOT carry a gate
// decision, because OpenCode's deriveSubagentSessionPermission() merges parent
// session denies into subagent sessions, and findLast semantics mean a parent
// gate deny would override the committer's gate allow.
//
// Base = core orchestrators that delegate to committer. Overlay agents add
// themselves via `gateExempt: true` when their pack is active.
let GATE_EXEMPT_AGENTS = new Set([
    "build",
    "coordination",
    "project-coordinator",
    "docs-steward",
]);

const VALID_DECISIONS = new Set(["allow", "ask", "deny"]);
const SCRIPT_NAME = "update-opencode-config.js";
const SCRIPT_PATH = `.opencode/sys-scripts/${SCRIPT_NAME}`;

// ─── vh-harness-profile.yml loader (data-driven roster source) ───────────
//
// Reads the project's vh-harness-profile.yml (S3 config-authority) and returns the
// parsed { overlays, features } the roster resolver needs. The parser is a tiny
// tolerant YAML-subset reader (no dependency) covering only the two shapes the
// profile uses: inline `overlays: [a, b]` / block `- a` lists, and
// `features:\n  backlog: true|false` bools. A missing or unparseable profile
// falls back to the empty (core-only) default — never throws.
function loadHarnessProfile() {
    const candidates = [
        ".vh-agent-harness/vh-harness-profile.yml",
    ];
    let raw = null;
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            try {
                raw = fs.readFileSync(candidate, "utf8");
                break;
            } catch {
                raw = null;
            }
        }
    }
    if (raw === null) {
        return { overlays: [], features: {} };
    }
    return parseProfileSubset(raw);
}

function parseProfileSubset(raw) {
    const overlays = [];
    const features = {};
    const lines = raw.split(/\r?\n/);
    let inOverlaysBlock = false;
    let inFeaturesBlock = false;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;

        // inline list form:  overlays: [<pack-a>, <pack-b>]
        const inlineOverlays = line.match(/^overlays:\s*\[(.*)\]\s*$/);
        if (inlineOverlays) {
            inOverlaysBlock = false;
            inFeaturesBlock = false;
            for (const item of inlineOverlays[1].split(",")) {
                const name = item.trim().replace(/^["']|["']$/g, "");
                if (name) overlays.push(name);
            }
            continue;
        }

        // block list form under overlays:
        if (/^overlays:\s*$/.test(trimmed)) {
            inOverlaysBlock = true;
            inFeaturesBlock = false;
            continue;
        }
        if (inOverlaysBlock) {
            const blockItem = line.match(/^\s+-\s+(.*)$/);
            if (blockItem) {
                const name = blockItem[1].trim().replace(/^["']|["']$/g, "");
                if (name) overlays.push(name);
                continue;
            }
            // first non-list line ends the block
            if (!/^\s+-/.test(line) && /^\S/.test(line)) {
                inOverlaysBlock = false;
            }
        }

        // features block: features:\n  backlog: true
        if (/^features:\s*$/.test(trimmed)) {
            inFeaturesBlock = true;
            inOverlaysBlock = false;
            continue;
        }
        if (inFeaturesBlock) {
            const feat = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
            if (feat && /^[^\s-]/.test(line)) {
                // nested feature map not supported here; only top-level bools
            }
            if (feat) {
                const key = feat[1];
                const val = feat[2].trim().replace(/^["']|["']$/g, "");
                features[key] = val === "true";
                continue;
            }
            if (/^[A-Za-z0-9_-]+:\s*$/.test(trimmed) && !line.startsWith(" ")) {
                inFeaturesBlock = false;
            }
        }
    }
    return { overlays, features };
}

// Merge CORE + active-overlay rosters into the resolved LOCATION_RULES /
// TASK_RULES / GATE_EXEMPT_AGENTS, and inject overlay cross-references into the
// core orchestrators' task allowlists. The active overlay packs are discovered
// DYNAMICALLY from .opencode/sys-scripts/permission-packs/ (see
// loadPermissionPacks); the directory holds exactly the active packs because the
// seam installer materializes only those. `activeOverlays` (from
// vh-harness-profile.yml) is used only for the activity log.
function resolveActiveRules(activeOverlays) {
    // Deep-copy the CORE maps so successive runs (e.g. --check after edits) do
    // not accumulate overlay entries across invocations.
    LOCATION_RULES = structuredCloneMap(CORE_LOCATION_RULES);
    TASK_RULES = structuredCloneMap(CORE_TASK_RULES);
    GATE_EXEMPT_AGENTS = new Set([
        "build",
        "coordination",
        "project-coordinator",
        "docs-steward",
    ]);

    const packs = loadPermissionPacks();
    for (const [packName, pack] of Object.entries(packs)) {
        for (const [agentName, def] of Object.entries(pack.agents)) {
            LOCATION_RULES[agentName] = { ...def.location };
            TASK_RULES[agentName] = { ...def.task };
            if (def.gateExempt) {
                GATE_EXEMPT_AGENTS.add(agentName);
            }
            // Inject delegation cross-refs into the named core orchestrators.
            for (const orchestrator of def.delegateFrom || []) {
                if (TASK_RULES[orchestrator]) {
                    TASK_RULES[orchestrator][agentName] = "allow";
                }
            }
        }
    }
}

function structuredCloneMap(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = v && typeof v === "object" ? { ...v } : v;
    }
    return out;
}

// ─── Cluster helpers ──────────────────────────────────────────────────

function getLeafNames(clusterName, leafCount) {
    return Array.from(
        { length: leafCount },
        (_, i) => `${clusterName}-${String.fromCharCode(97 + i)}`,
    );
}

function expandClusterRules() {
    for (const [clusterName, def] of Object.entries(CLUSTER_DEFS)) {
        const leafNames = getLeafNames(clusterName, def.leafCount);

        // Auto-generate LOCATION_RULES for each leaf
        for (const leafName of leafNames) {
            LOCATION_RULES[leafName] = { ...def.leafBaseRule };
        }

        // Auto-generate TASK_RULES for each leaf
        for (const leafName of leafNames) {
            TASK_RULES[leafName] = { "*": "deny" };
        }

        // Update orchestrator task allowlist with all leaves
        const orchestratorTask = TASK_RULES[clusterName];
        if (orchestratorTask) {
            for (const leafName of leafNames) {
                orchestratorTask[leafName] = "allow";
            }
        }
    }
}

// ─── Leaf agent block generation in opencode.jsonc ────────────────────

function generateLeafBlockLines(clusterName, leafName, leafIndex) {
    const letterUpper = String.fromCharCode(65 + leafIndex);
    const def = CLUSTER_DEFS[clusterName];
    const i = "        "; // 8-space indent (agent block level in opencode.jsonc)
    const lines = [
        `${i}"${leafName}": {`,
        `${i}    "description": "Leaf ${letterUpper} of ${clusterName} cluster",`,
        `${i}    "mode": "subagent",`,
        `${i}    "hidden": true,`,
        `${i}    "prompt": "{file:.opencode/agents/${leafName}.md}",`,
        `${i}    "model": "{file:./.local/config/agent-model/${leafName}}",`,
    ];
    if (def.temperature !== undefined) {
        lines.push(`${i}    "temperature": ${def.temperature},`);
    }
    lines.push(
        `${i}    "permission": {`,
        `${i}        "edit": "deny",`,
        `${i}        "webfetch": "deny",`,
        `${i}        "task": {`,
        `${i}            "*": "deny",`,
        `${i}        },`,
        `${i}        "bash": {`,
        `${i}        },`,
        `${i}    },`,
        `${i}},`,
    );
    return lines;
}

/**
 * Try to find an agent block by name inside the "agent" top-level object.
 * Returns { start, end } line indices (inclusive of braces) or null.
 */
function tryFindPropertyBlock(lines, pathParts) {
    try {
        return findPropertyBlock(lines, pathParts);
    } catch {
        return null;
    }
}

function ensureLeafAgentBlocks(lines) {
    for (const [clusterName, def] of Object.entries(CLUSTER_DEFS)) {
        const leafNames = getLeafNames(clusterName, def.leafCount);

        // Find orchestrator block to determine insertion anchor
        const orchestratorBlock = tryFindPropertyBlock(lines, [
            "agent",
            clusterName,
        ]);
        if (!orchestratorBlock) {
            fail(
                `Cluster orchestrator "${clusterName}" not found in opencode.jsonc agent blocks`,
            );
        }

        // Collect existing leaf blocks to remove (stale or regenerating)
        const blocksToRemove = [];
        for (const leafName of leafNames) {
            const block = tryFindPropertyBlock(lines, ["agent", leafName]);
            if (block) {
                blocksToRemove.push({ name: leafName, ...block });
            }
        }

        // Also find any stale leaf blocks that are no longer in the cluster
        // (e.g., leafCount was reduced). Scan for {clusterName}-{letter} pattern.
        const leafPattern = new RegExp(
            `^(\\s*)"${escapeRegExp(clusterName)}-([a-z])":\\s*\\{\\s*$`,
        );
        for (let idx = 0; idx < lines.length; idx += 1) {
            const match = lines[idx].match(leafPattern);
            if (match) {
                const letter = match[2];
                const leafName = `${clusterName}-${letter}`;
                if (!leafNames.includes(leafName)) {
                    const block = tryFindPropertyBlock(lines, [
                        "agent",
                        leafName,
                    ]);
                    if (block) {
                        blocksToRemove.push({ name: leafName, ...block });
                    }
                }
            }
        }

        // Remove blocks from bottom to top so line indices stay valid
        blocksToRemove.sort((a, b) => b.start - a.start);
        for (const block of blocksToRemove) {
            let removeStart = block.start;
            let removeEnd = block.end;
            lines.splice(removeStart, removeEnd - removeStart + 1);
        }

        // Re-find orchestrator block (indices may have shifted)
        const updatedOrchBlock = findPropertyBlock(lines, [
            "agent",
            clusterName,
        ]);

        // Generate new leaf block lines
        const allLeafLines = [];
        for (let i = 0; i < leafNames.length; i += 1) {
            allLeafLines.push(
                ...generateLeafBlockLines(clusterName, leafNames[i], i),
            );
        }

        // Insert right after the orchestrator block's closing brace
        lines.splice(updatedOrchBlock.end + 1, 0, ...allLeafLines);
    }
}

// ─── Leaf .md file generation ─────────────────────────────────────────

function generateLeafMdFiles() {
    for (const [clusterName, def] of Object.entries(CLUSTER_DEFS)) {
        const leafNames = getLeafNames(clusterName, def.leafCount);
        if (leafNames.length === 0) continue;

        // Read the base template (first leaf)
        const templateName = leafNames[0]; // e.g., "commit-reviewer-a"
        const templatePath = `.opencode/agents/${templateName}.md`;

        if (!fs.existsSync(templatePath)) {
            console.log(
                `  Skipping ${clusterName} leaf .md generation: template ${templatePath} not found`,
            );
            continue;
        }

        const templateContent = fs.readFileSync(templatePath, "utf8");

        for (let i = 1; i < leafNames.length; i += 1) {
            const leafName = leafNames[i];
            const letterUpper = String.fromCharCode(65 + i); // B, C, D, ...
            const leafPath = `.opencode/agents/${leafName}.md`;

            if (fs.existsSync(leafPath)) {
                // Verify it matches the template (except description)
                const existing = fs.readFileSync(leafPath, "utf8");
                const expected = templateContent.replace(
                    new RegExp(
                        `Leaf A of ${escapeRegExp(clusterName)} cluster`,
                        "g",
                    ),
                    `Leaf ${letterUpper} of ${clusterName} cluster`,
                );
                if (existing === expected) continue;
                console.log(`  Updating ${leafPath} to match template`);
            }

            const content = templateContent.replace(
                new RegExp(
                    `Leaf A of ${escapeRegExp(clusterName)} cluster`,
                    "g",
                ),
                `Leaf ${letterUpper} of ${clusterName} cluster`,
            );
            fs.writeFileSync(leafPath, content);
            console.log(`  Generated ${leafPath}`);
        }
    }
}

// ─── Validation ───────────────────────────────────────────────────────

const VALID_DECISIONS_SET = VALID_DECISIONS; // alias for clarity below

function printUsage() {
    console.log(`Usage:
  node .opencode/sys-scripts/${SCRIPT_NAME} [--config <path>] [--check]

Edit COMMANDS, CORE_*_RULES, and CLUSTER_DEFS in this file,
then run the script to re-render every permission.bash and permission.task
block in opencode.jsonc and regenerate hidden leaf agent blocks. The active
agent roster is resolved from vh-harness-profile.yml (overlays[] + features).
`);
}

function fail(message) {
    throw new Error(message);
}

function parseArgs(argv) {
    const options = {
        configPath: DEFAULT_CONFIG_PATH,
        check: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--config") {
            options.configPath = argv[index + 1] || "";
            index += 1;
        } else if (arg === "--check") {
            options.check = true;
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        } else {
            fail(`Unknown argument: ${arg}`);
        }
    }

    if (!options.configPath) {
        fail("--config requires a path");
    }

    return options;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBlockRange(lines, startIndex) {
    let depth = 0;
    let seenOpen = false;

    for (let index = startIndex; index < lines.length; index += 1) {
        for (const char of lines[index]) {
            if (char === "{") {
                depth += 1;
                seenOpen = true;
            } else if (char === "}") {
                depth -= 1;
                if (seenOpen && depth === 0) {
                    return { start: startIndex, end: index };
                }
            }
        }
    }

    fail(
        `Could not find closing brace for block starting at line ${startIndex + 1}`,
    );
}

function findPropertyBlock(lines, pathParts) {
    let searchStart = 0;
    let searchEnd = lines.length - 1;
    let block = null;

    for (const part of pathParts) {
        const propertyPattern = new RegExp(
            `^(\\s*)"${escapeRegExp(part)}":\\s*\\{\\s*$`,
        );
        let foundIndex = -1;

        for (let index = searchStart; index <= searchEnd; index += 1) {
            if (propertyPattern.test(lines[index])) {
                foundIndex = index;
                break;
            }
        }

        if (foundIndex === -1) {
            fail(`Could not locate object path: ${pathParts.join(".")}`);
        }

        block = findBlockRange(lines, foundIndex);
        searchStart = block.start + 1;
        searchEnd = block.end - 1;
    }

    return block;
}

function getEntryIndent(lines, block) {
    for (let index = block.start + 1; index < block.end; index += 1) {
        const match = lines[index].match(/^(\s*)"/);
        if (match) {
            return match[1];
        }
    }

    const blockIndent = lines[block.start].match(/^(\s*)/)?.[1] || "";
    return `${blockIndent}    `;
}

function getBashBlockPath(location) {
    if (location === "default") {
        return ["permission", "bash"];
    }
    return ["agent", location, "permission", "bash"];
}

function getTaskBlockPath(location) {
    return ["agent", location, "permission", "task"];
}

function getAgentLocationNames() {
    return Object.keys(LOCATION_RULES).filter(
        (location) => location !== "default",
    );
}

function getCommandGroupNames() {
    return Object.keys(COMMANDS).filter((groupName) => groupName !== "custom");
}

function getCustomCommandEntries() {
    return Object.entries(COMMANDS.custom);
}

function ensureUniqueCommands(commands) {
    const seen = new Set();
    for (const command of commands) {
        if (seen.has(command)) {
            fail(`Duplicate rendered command: ${command}`);
        }
        seen.add(command);
    }
}

function validateRules() {
    const commandGroupNames = getCommandGroupNames();
    const agentLocationNames = getAgentLocationNames();

    for (const [location, rule] of Object.entries(LOCATION_RULES)) {
        if (!VALID_DECISIONS_SET.has(rule.wildcard)) {
            fail(`Invalid wildcard decision for ${location}`);
        }
        if (!VALID_DECISIONS_SET.has(rule.devSh)) {
            fail(`Invalid devSh decision for ${location}`);
        }

        for (const groupName of commandGroupNames) {
            // Agents that delegate to committer may omit gate — their parent
            // deny would bleed into the committer's subagent session.
            if (
                groupName === "gate" &&
                GATE_EXEMPT_AGENTS.has(location)
            ) {
                if (Object.prototype.hasOwnProperty.call(rule, "gate")) {
                    fail(
                        `LOCATION_RULES.${location} must NOT have a gate key (gate deny bleeds into committer subagent)`,
                    );
                }
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(rule, groupName)) {
                fail(`Missing LOCATION_RULES.${location}.${groupName}`);
            }
            if (!VALID_DECISIONS_SET.has(rule[groupName])) {
                fail(`Invalid ${groupName} decision for ${location}`);
            }
        }
    }

    for (const location of agentLocationNames) {
        if (!Object.prototype.hasOwnProperty.call(TASK_RULES, location)) {
            fail(`Missing TASK_RULES entry for ${location}`);
        }
    }

    for (const [location, taskRule] of Object.entries(TASK_RULES)) {
        if (!agentLocationNames.includes(location)) {
            fail(`TASK_RULES has unknown location: ${location}`);
        }
        if (!Object.prototype.hasOwnProperty.call(taskRule, "*")) {
            fail(`TASK_RULES.${location} must include "*" wildcard`);
        }

        for (const [target, decision] of Object.entries(taskRule)) {
            if (!VALID_DECISIONS_SET.has(decision)) {
                fail(`Invalid TASK_RULES decision: ${location}.${target}`);
            }
            if (target !== "*" && !agentLocationNames.includes(target)) {
                fail(`Unknown TASK_RULES target: ${location}.${target}`);
            }
        }
    }

    for (const [command, resolver] of getCustomCommandEntries()) {
        if (typeof resolver !== "function") {
            fail(`Custom command resolver must be a function: ${command}`);
        }
    }

    ensureUniqueCommands([
        ...getCommandGroupNames().flatMap((groupName) => COMMANDS[groupName]),
        ...getCustomCommandEntries().map(([command]) => command),
        "vh-agent-harness *",
        "*",
    ]);
}

// ─── Rendering ────────────────────────────────────────────────────────

function sortCommands(commands) {
    return [...commands].sort((left, right) => {
        const lengthDelta = left.length - right.length;
        if (lengthDelta !== 0) {
            return lengthDelta;
        }
        return left.localeCompare(right);
    });
}

function buildRenderedEntries(rule) {
    const rendered = [];

    for (const groupName of getCommandGroupNames()) {
        // Skip command groups not present in this agent's rule
        // (e.g., gate is intentionally omitted for GATE_EXEMPT_AGENTS)
        if (!Object.prototype.hasOwnProperty.call(rule, groupName)) {
            continue;
        }
        for (const command of COMMANDS[groupName]) {
            rendered.push([command, rule[groupName]]);
        }
    }

    for (const [command, resolver] of getCustomCommandEntries()) {
        rendered.push([command, resolver(rule.__locationName)]);
    }

    return sortCommands(rendered.map(([command]) => command)).map((command) => {
        const match = rendered.find(
            ([renderedCommand]) => renderedCommand === command,
        );
        return match;
    });
}

function renderBashLines(lines, block, location) {
    const rule = LOCATION_RULES[location];
    if (!rule) {
        fail(`Missing LOCATION_RULES entry for ${location}`);
    }

    const indent = getEntryIndent(lines, block);
    const renderedEntries = buildRenderedEntries({
        ...rule,
        __locationName: location,
    });
    const newLines = [
        `${indent}"*": "${rule.wildcard}",`,
        ...renderedEntries.map(
            ([command, decision]) => `${indent}"${command}": "${decision}",`,
        ),
        `${indent}"vh-agent-harness *": "${rule.devSh}",`,
    ];

    lines.splice(block.start + 1, block.end - block.start - 1, ...newLines);
}

function renderTaskLines(lines, block, location) {
    const rule = TASK_RULES[location];
    if (!rule) {
        fail(`Missing TASK_RULES entry for ${location}`);
    }

    const indent = getEntryIndent(lines, block);
    const newLines = Object.entries(rule).map(
        ([target, decision]) => `${indent}"${target}": "${decision}",`,
    );

    lines.splice(block.start + 1, block.end - block.start - 1, ...newLines);
}

// ─── Main ─────────────────────────────────────────────────────────────

function main() {
    // 1. Resolve the active roster from vh-harness-profile.yml (core + active
    //    overlay packs). Unknown packs are skipped with a notice.
    const profile = loadHarnessProfile();
    resolveActiveRules(profile.overlays || []);
    console.log(
        `  Active overlays: ${
            (profile.overlays || []).join(", ") || "(none — core only)"
        }`,
    );

    // 2. Expand cluster rules (auto-generate leaf LOCATION_RULES and TASK_RULES)
    expandClusterRules();

    // 3. Validate all rules
    validateRules();

    const options = parseArgs(process.argv.slice(2));
    const configPath = path.resolve(options.configPath);
    const source = fs.readFileSync(configPath, "utf8");
    const lines = source.split("\n");

    // 4. Ensure hidden leaf agent blocks exist in opencode.jsonc
    ensureLeafAgentBlocks(lines);

    // 5. Render bash permissions for all active agents (core + active overlays
    //    + auto-generated leaves). An agent whose block is absent from this
    //    opencode.jsonc (e.g. an overlay agent when running against a core-only
    //    file) is skipped with a notice rather than failing — this keeps the
    //    script correct whether run against core-only or fully-merged configs.
    for (const location of Object.keys(LOCATION_RULES)) {
        const block = tryFindPropertyBlock(lines, getBashBlockPath(location));
        if (!block) {
            console.log(`  (skip bash for "${location}": block not present)`);
            continue;
        }
        renderBashLines(lines, block, location);
    }

    // 6. Render task permissions for all active agents
    for (const location of getAgentLocationNames()) {
        const block = tryFindPropertyBlock(lines, getTaskBlockPath(location));
        if (!block) {
            console.log(`  (skip task for "${location}": block not present)`);
            continue;
        }
        renderTaskLines(lines, block, location);
    }

    // 7. Write updated opencode.jsonc
    const updatedSource = lines.join("\n");
    const hasDrift = updatedSource !== source;
    if (options.check && hasDrift) {
        fail(
            `Permission drift detected in ${configPath}. Re-run: vh-agent-harness exec node ${SCRIPT_PATH}`,
        );
    }

    if (!options.check && hasDrift) {
        fs.writeFileSync(configPath, updatedSource);
    }

    // 8. Generate leaf .md files (clone from template)
    if (!options.check) {
        generateLeafMdFiles();
    }

    if (options.check) {
        console.log(`Bash and task permissions are in sync for ${configPath}`);
    } else {
        console.log(`Updated bash and task permissions in ${configPath}`);
    }
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
