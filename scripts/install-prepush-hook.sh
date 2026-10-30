#!/usr/bin/env bash
# scripts/install-prepush-hook.sh — install/remove the OPTIONAL human-side
# pre-push companion hook (push-safety Phase 3, O3).
#
# Usage:
#   scripts/install-prepush-hook.sh install     (default when no arg given)
#   scripts/install-prepush-hook.sh uninstall
#   scripts/install-prepush-hook.sh status
#
# What "install" does: point this clone's `core.hooksPath` at the repo's
# committed `.githooks/` directory (nothing is copied, nothing is written
# under .git/hooks). The hook itself (.githooks/pre-push) delegates every
# branch update to scripts/prepush-check.sh — see its header for policy.
#
# Preservation rules (fail-closed — the installer never silently disables
# existing hooks):
#   - if `core.hooksPath` is ALREADY set to a directory other than
#     `.githooks`, install REFUSES: your hooks live somewhere deliberate.
#     Copy .githooks/pre-push there yourself if you want it.
#   - if `core.hooksPath` is unset but the COMMON git dir's `hooks/`
#     contains ANY non-sample hook, install REFUSES and lists them:
#     switching hooksPath would stop them from running. Merge them into
#     .githooks/ first, then re-run. (The scan uses the COMMON dir
#     (`git rev-parse --git-common-dir`) because that is where hooks live
#     when hooksPath is unset — a linked worktree's own git dir has no
#     hooks/ and must never mask the shared ones.)
#   - install is idempotent: re-running with hooksPath already `.githooks`
#     succeeds without changing anything.
#
# uninstall restores the prior state exactly: it unsets `core.hooksPath`
# ONLY when it currently equals `.githooks` (a different value is never
# touched) and is a no-op success when nothing is installed.
#
# The hook is per-clone and bypassable (`git push --no-verify`) by design;
# it is never the enforcement layer of record. Agents do not install hooks;
# this script is a human/operator action.
#
# Exit: 0 success (or idempotent no-op), 1 refusal/usage error.

set -uo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
HOOKS_DIR_NAME=".githooks"
HOOK_REL="$HOOKS_DIR_NAME/pre-push"
# Hooks live under the COMMON git dir when core.hooksPath is unset — in a
# linked worktree `--git-dir` is the worktree-scoped admin dir (no hooks/),
# so the legacy-hook scan must use `--git-common-dir` (B-F1).
COMMON_DIR=$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null) || COMMON_DIR=""
if [ -z "$COMMON_DIR" ]; then
    COMMON_DIR=$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null) || COMMON_DIR=""
fi
if [ -z "$COMMON_DIR" ]; then
    echo "install-prepush-hook: $REPO_ROOT is not a git repository" >&2
    exit 1
fi
case "$COMMON_DIR" in
    /*) ;;
    *) COMMON_DIR="$REPO_ROOT/$COMMON_DIR" ;;
esac

die() { echo "install-prepush-hook: $*" >&2; exit 1; }
say() { echo "install-prepush-hook: $*"; }

cmd="${1:-install}"
[ $# -eq 0 ] || [ $# -eq 1 ] || die "usage: $0 [install|uninstall|status]"

hooks_path_current() { git -C "$REPO_ROOT" config core.hooksPath || true; }

non_sample_hooks() {
    # Executable or otherwise non-empty hooks in the default location.
    local d="$1" h
    [ -d "$d" ] || return 0
    for h in "$d"/*; do
        [ -f "$h" ] || continue
        case "$h" in *.sample) continue ;; esac
        if [ -x "$h" ] || [ -s "$h" ]; then
            printf '%s\n' "$(basename -- "$h")"
        fi
    done
}

hook_executable_ok() {
    [ -f "$REPO_ROOT/$HOOK_REL" ] || { say "  missing: $HOOK_REL is not in the working tree"; return 1; }
    [ -x "$REPO_ROOT/$HOOK_REL" ] || { say "  not executable: $HOOK_REL (run: chmod +x $HOOK_REL — it is committed 755; a fresh clone has it executable)"; return 1; }
    return 0
}

case "$cmd" in
    status)
        cur=$(hooks_path_current)
        say "core.hooksPath = ${cur:-<unset>}"
        hook_executable_ok && say "$HOOK_REL present + executable" || true
        legacy=$(non_sample_hooks "$COMMON_DIR/hooks")
        if [ -n "$legacy" ]; then
            say "non-sample hooks in $COMMON_DIR/hooks (would BLOCK install while hooksPath is unset):"
            printf '  %s\n' $legacy
        else
            say "no non-sample hooks in $COMMON_DIR/hooks"
        fi
        ;;

    install)
        cur=$(hooks_path_current)
        if [ -n "$cur" ]; then
            if [ "$cur" = "$HOOKS_DIR_NAME" ]; then
                hook_executable_ok || die "$HOOK_REL problem — fix it (see above); hooksPath already points at $HOOKS_DIR_NAME"
                say "already installed (core.hooksPath = $HOOKS_DIR_NAME) — nothing to do."
                exit 0
            fi
            die "core.hooksPath is already set to '$cur' — respecting it. Copy $HOOK_REL into that directory manually if you want this hook."
        fi
        legacy=$(non_sample_hooks "$COMMON_DIR/hooks")
        if [ -n "$legacy" ]; then
            say "REFUSING: switching core.hooksPath to $HOOKS_DIR_NAME would stop these existing hooks from running:"
            printf '  %s\n' $legacy
            die "merge them into $HOOKS_DIR_NAME/ (keeping their behavior) and re-run, or set hooksPath yourself."
        fi
        hook_executable_ok || die "$HOOK_REL problem — see above."
        git -C "$REPO_ROOT" config core.hooksPath "$HOOKS_DIR_NAME"
        say "installed: core.hooksPath = $HOOKS_DIR_NAME (this clone only)."
        say "undo with: scripts/install-prepush-hook.sh uninstall"
        ;;

    uninstall)
        cur=$(hooks_path_current)
        if [ -z "$cur" ]; then
            say "not installed (core.hooksPath unset) — nothing to do."
            exit 0
        fi
        if [ "$cur" != "$HOOKS_DIR_NAME" ]; then
            die "core.hooksPath is '$cur' (not ours) — leaving it untouched."
        fi
        git -C "$REPO_ROOT" config --unset core.hooksPath
        say "uninstalled: core.hooksPath restored to <unset> (prior state)."
        ;;

    *)
        die "unknown subcommand '$cmd' — usage: $0 [install|uninstall|status]"
        ;;
esac
