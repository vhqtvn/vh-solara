// Deny-pattern backstop for shell-guard — GENERIC CORE ENGINE (platform_managed).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ OWNERSHIP: platform_managed (generic core engine).                        │
// │ This file ships with the harness starter and is fully owned by it.        │
// │ A consuming project MUST NOT edit this file — extend instead via          │
// │ `forbidden-patterns.project.js` (project_owned).                           │
// └──────────────────────────────────────────────────────────────────────────┘
//
// This file holds ONLY the GENERIC deny-rule ENGINE (the shared inspector
// allowIf machinery) and a small set of GENERIC SAFETY rules that apply to any
// project. It is intentionally free of project-specific deny-rules.
//
// Project-specific rules (project-managed infra like cloud-provider lifecycle
// bans, project auth/identity DB-table enumeration bans, VPS host
// fingerprints, project JWT-secret env-var names, project-specific image-build-
// on-VPS bans) belong in the PROJECT overlay file
// `forbidden-patterns.project.js` (project_owned), NOT here. The harness
// scaffolds a blank `forbidden-patterns.project.js` on install; the project
// fills it. See forbidden-patterns.project.example.js for the pattern.
//
// These rules apply to the full command string, including everything wrapped
// inside `vh-agent-harness exec ...`, `bash -c '...'`, or ssh remote payloads. Each
// rule has a regex (`re`), a short human reason (`why`), and an optional
// `allowIf` regex that whitelists narrow legitimate uses.
//
// Consumption (see `denyByForbiddenPatterns` in shell-guard.js):
//   if `re.test(cmd)` AND NOT (`allowIf` && `allowIf.test(cmd))` -> DENY.
// So an `allowIf` CARVES OUT benign forms from an otherwise-broad `re`.
//
// FP philosophy: opencode.jsonc grants `"vh-agent-harness *": "allow"` to many agents,
// which auto-passes the whole command string (including any `bash -c` payload)
// without inspecting inside it. This file is the ONLY layer catching dangerous
// ops buried in `vh-agent-harness exec bash -c '...'`. So the regex layer must stay,
// but each rule must fire on the genuinely-dangerous INVOCATION and carve out
// benign INSPECTION/REFERENCE forms via `allowIf` (grep/rg/echo/which/ls/test/
// stat of the trigger is benign; INVOKING the trigger is not).
//
// Naming-only patterns (no full AST). The goal is to make the easy/default
// mistakes hard, not to defeat an actively adversarial agent. Adjust when a
// legitimate workflow regresses, but document why.

// ── shared inspector-allowIf builders ────────────────────────────────────────
//
// When a forbidden trigger appears as the ARGUMENT of a read-only inspector
// (grep/rg/echo/which/ls/test/stat/man/...) rather than as a real invocation,
// the command is benign and must be exempted. Two tiers:
//
//   - FULL: read-only inspectors including file readers (cat/head/tail). Safe
//     for rules whose trigger is a TOOL NAME or DESTRUCTIVE VERB — reading a
//     doc that mentions "useradd" is benign.
//   - EXISTENCE: only existence/metadata probes (test/[/ls/stat/echo/printf).
//     Used for credential-file rules where `cat ~/.<provider>/credentials` is the
//     DANGEROUS form and must NOT be exempted.
//
// The regex matches when the inspector verb is in COMMAND POSITION: at the
// start of the command (after optional leading env-var assignments and an
// optional `vh-agent-harness exec` wrapper), or right inside a `bash -c '...'` quote.
// Residual gap: an `echo X && dangerous Y` chain is exempted by the leading
// echo; this is adversarial, rare in practice, and documented as residual
// FP-risk in docs/ai/shell-execution.md.
export const INSPECTOR_FULL =
    "grep|rg|cat|head|tail|less|more|echo|printf|which|command|type|file|stat|test|\\[|read|ls|man";
export const INSPECTOR_EXISTENCE = "test|\\[|ls|stat|echo|printf";

export function inspectorAllowIf(inspectorGroup) {
    // Two alternatives:
    //   1. bare or vh-agent-harness exec-wrapped inspector in command position
    //   2. inspector right inside `bash -c '...'` / `sh -c "..."` / `zsh -c ...`
    //
    // LEADING-INSPECTOR CHAIN GUARD (closes the bypass found in commit review):
    // a negative lookahead at the very start refuses the carve-out if ANY shell
    // control / substitution operator appears in the command string. This blocks
    // `echo x && cat ~/.<provider>/credentials`, `echo x; useradd y`,
    // `grep p f | base64`, `$(...)` substitution, etc. — i.e. any shape where a
    // second command leg could carry the dangerous invocation behind a harmless
    // leading inspector. Narrow FP cost: piped inspectors like `grep foo | head`
    // are no longer exempt (use `rg` or unpiped `grep`).
    return new RegExp(
        "(?![\\s\\S]*(?:&&|\\|\\||[;&|`]|\\$\\())" +
        "(?:^\\s*" +
            "(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*" + // leading env-var assignments
            "(?:harness\\s+(?:[A-Za-z]+\\s+)*exec\\s+)?" + // harness [subcmd] exec
            "(?:" + inspectorGroup + ")(?=\\s|$)" + // inspector verb in command position
        "|\\b(?:bash|sh|zsh)\\s+-[a-z]*c\\s+['\"]\\s*" + // inside shell -c '...'
            "(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*" +
            "(?:" + inspectorGroup + ")(?=\\s|$)" +
        ")"
    );
}

// Pre-built allowIf objects (reused across rules).
export const ALLOW_IF_INSPECTOR_FULL = inspectorAllowIf(INSPECTOR_FULL);
export const ALLOW_IF_INSPECTOR_EXISTENCE = inspectorAllowIf(INSPECTOR_EXISTENCE);

// FORBIDDEN_PATTERNS — GENERIC safety rules only.
//
// Project-specific deny-rules (project-managed infra lifecycle bans, project
// auth/identity DB-table enumeration bans, etc.) are appended at runtime by the
// aggregator `forbidden-patterns.js`, which merges this core array with the
// project's `forbidden-patterns.project.js` (project_owned). A consuming project
// reproduces its own behavior by populating its project file — never by editing
// this one.
export const FORBIDDEN_PATTERNS = [
    {
        id: "apt-install-ad-hoc",
        re: /\bapt(-get)?\s+install\b/,
        allowIf: ALLOW_IF_INSPECTOR_FULL,
        why:
            "Do not run apt-get install at runtime. Container packages belong in" +
            " the Dockerfile. Add the dep and rebuild the image; runtime installs" +
            " disappear on the next rebuild and create silent drift.",
    },
    {
        id: "user-group-mutation",
        // Broad trigger: the bare tool name anywhere. The allowIf below carves
        // out benign INSPECTION forms (`grep usermod README`, `command -v
        // useradd`, `which usermod`, `ls /usr/sbin/useradd`, `echo "...useradd..."`)
        // so only real INVOCATIONS (`sudo useradd x`, `usermod -aG ...`) fire.
        re: /\b(usermod|groupmod|groupadd|useradd|gpasswd|chpasswd)\b/,
        allowIf: ALLOW_IF_INSPECTOR_FULL,
        why:
            "Do not mutate users or groups inside the dev container. Fix the" +
            " image / compose file, not the running container.",
    },
    {
        id: "ssh-host-key-bypass",
        // Anchored to the `-o <bypass-flag>` form. FP surface: `grep -o
        // StrictHostKeyChecking=no file` (grep's `-o` flag, not ssh's). The
        // allowIf exempts grep/echo/which/etc. in command position.
        re: /-o\s+(StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null)\b/,
        allowIf: ALLOW_IF_INSPECTOR_FULL,
        why:
            "Do not disable SSH host-key verification. The dev container has" +
            " .local/ssh/ bind-mounted RO, so you cannot append to known_hosts" +
            " from inside — that is intentional. Run `harness ssh-trust <host>`" +
            " on the host side once, then ssh from inside with no flags. MITM" +
            " on a public IP is real.",
    },
    {
        id: "scp-upload",
        // Anchored to `scp ... user@host:` (upload shape). allowIf exempts
        // echo/grep/doc references that contain the literal pattern.
        re: /\bscp\b[^|;&\n]+@[^\s:]+:/,
        allowIf: ALLOW_IF_INSPECTOR_FULL,
        why:
            "Do not upload source via scp. scp uploads leave a remote host out of" +
            " sync with git and bypass managed releases. Land changes via the" +
            " configured release flow (git push + on-host pull, or container image" +
            " rebuild).",
    },
    {
        id: "system-tmp-access",
        // Deny ANY reference to system /tmp. All scratch + handoff files MUST
        // live in the repo tmp/ (relative) or the container /workspace/tmp/.
        //
        // NO allowIf on purpose: a write via redirection starts with an
        // inspector verb (`cat > /tmp/x`, `tee /tmp/x`), so the shared
        // _ALLOW_IF_INSPECTOR_* carve-outs would wrongly exempt the exact
        // write we are blocking. A blanket deny is the only gap-free form.
        //
        // The leading boundary `(^|[^\w.\/~-])` and trailing `(\/|[^\w]|$)` keep
        // this OFF the sanctioned locations: /workspace/tmp/, ./tmp/, the
        // repo-absolute .../<project-slug>/tmp/, and relative tmp/ all have
        // a word/`.`/`/`/`~`/`-` char immediately before "tmp", so none match.
        // /tmpfoo and /var/tmp are also left alone.
        re: /(^|[^\w.\/~-])\/tmp(\/|[^\w]|$)/,
        why:
            "Do not read or write system /tmp. Out-of-repo writes trigger" +
            " permission prompts and break unattended runs. Use the repo tmp/" +
            " (relative) for scratch, or /workspace/tmp/ inside the dev" +
            " container. Reviewer verdicts are RETURNED as message text, never" +
            " written to a file.",
    },
    {
        id: "git-mutation-bypass",
        re: /\bgit\s+(add|commit|push|reset|commit-tree|update-ref|checkout|merge|rebase|stash|branch|restore|cherry-pick|revert|clean|rm|mv|tag|am|apply|switch)\b/,
        allowIf: /^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:\.opencode\/scripts\/commit-gate\.sh|harness\s+exec\b)/,
        why:
            "Git mutations must go through the commit-gate wrapper. " +
            "Only the committer agent (C) may execute git writes, and only " +
            "through `.opencode/scripts/commit-gate.sh`. " +
            "SKIP_COMMIT_GATE is operator-only (host terminal). " +
            "See .opencode/docs/git-execution-routing.md.",
    },
];
