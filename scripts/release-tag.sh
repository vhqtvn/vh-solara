#!/usr/bin/env bash
# scripts/release-tag.sh — sanctioned release-tag wrapper for the vh-solara repo.
#
# This is the ONLY thing in the repo that runs `git tag` / `git push` for a
# release. The `releaser` agent invokes it as a simple command
# (`scripts/release-tag.sh vX.Y.Z`); shell-guard inspects that command STRING,
# finds no `git (tag|push)` token in it, and passes it. The git mutations live
# inside THIS file, which shell-guard does not parse.
#
# Tag-driven release: pushing the tag triggers .github/workflows/release.yml,
# which builds cross-platform binaries (stamping cmd.Version via ldflags) and
# creates the GitHub release with auto-generated notes.
#
# Usage:
#   scripts/release-tag.sh vX.Y.Z
#
# Env:
#   RELEASE_TAG_MESSAGE_FILE  repo-relative path to an annotated-tag message
#                             file (e.g. tmp/release-msg-v1.2.3.txt). Must be
#                             repo-relative: no absolute paths (leading `/`),
#                             no `..` components, and must canonicalize under
#                             the repo root (`git rev-parse --show-toplevel`).
#                             If set, validated, AND present, used verbatim via
#                             `git tag -a -F`; otherwise a minimal
#                             `Release <version>` message is used via
#                             `git tag -a -m`.
#
# Invariants enforced before any mutation:
#   - exactly one arg matching ^v[0-9]+\.[0-9]+\.[0-9]+$
#   - working tree clean (git status --porcelain empty)
#   - tag does not already exist
#   - tags HEAD only (no arbitrary commit arg)
#   - pushes ONLY the single tag (never --tags / --all / --force)
#
# Output: a single JSON line on stdout:
#   { "ok": <bool>, "tag": "<vX.Y.Z>", "commit": "<sha>", "pushed": <bool>, "error": <string|null> }
#
# This script performs a PROMOTION on an already-reviewed HEAD. It deliberately
# does NOT acquire the commit-gate lock or touch commit-gate.sh; the change was
# committed through the gated-commit protocol in a prior step.

set -euo pipefail

# --- helpers -----------------------------------------------------------------

emit_json() {
    # emit_json <ok> <tag> <commit> <pushed> <error>
    local ok="$1" tag="${2:-}" commit="${3:-}" pushed="${4:-}" error="${5:-}"
    # Minimal JSON string escaping for the error/tag/commit fields. tag is a
    # validated semver and commit is a hex sha, so only `error` can carry
    # arbitrary text; escape backslash, quote, and control chars.
    local esc
    esc=$(printf '%s' "$error" \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
              -e 's/	/\\t/g' -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g')
    local ok_l pushed_l
    if [ "$ok" = "1" ]; then ok_l="true"; else ok_l="false"; fi
    if [ "$pushed" = "1" ]; then pushed_l="true"; else pushed_l="false"; fi
    printf '{"ok": %s, "tag": "%s", "commit": "%s", "pushed": %s, "error": %s}\n' \
        "$ok_l" "$tag" "$commit" "$pushed_l" \
        "$(if [ -z "$error" ]; then printf 'null'; else printf '"%s"' "$esc"; fi)"
}

refuse() {
    # refuse <message>  -> ok=0, pushed=0, exit 0 (refusal is a result, not a crash)
    emit_json 0 "${VERSION:-}" "${HEAD_SHA:-}" 0 "$1"
    exit 0
}

# --- arg validation ----------------------------------------------------------

# The wrapper invariant is EXACTLY one arg. Reading only `$1` would silently
# ignore extras (e.g. `release-tag.sh v1.2.3 unexpected`); refuse instead.
if [ "$#" -ne 1 ]; then
    refuse "expected exactly one version argument (got $#, expected vX.Y.Z)"
fi

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    refuse "missing version argument (expected vX.Y.Z)"
fi
if ! printf '%s' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    refuse "invalid version '$VERSION': must match ^v[0-9]+\\.[0-9]+\\.[0-9]+\$ (e.g. v1.2.3)"
fi

# --- pre-mutation invariants -------------------------------------------------

# Resolve HEAD sha first (also confirms we are inside a git repo).
if ! HEAD_SHA=$(git rev-parse HEAD 2>/dev/null); then
    refuse "not inside a git repository (git rev-parse HEAD failed)"
fi

# Working tree must be clean. The releaser must not try to stage/commit first;
# a dirty tree means the HEAD we tag would not match what was reviewed.
STATUS_OUT=$(git status --porcelain 2>/dev/null || true)
if [ -n "$STATUS_OUT" ]; then
    refuse "working tree is not clean (git status --porcelain is non-empty); commit or stash changes before releasing"
fi

# Tag must not already exist.
if git rev-parse --verify --quiet "refs/tags/${VERSION}" >/dev/null 2>&1; then
    refuse "tag ${VERSION} already exists (refs/tags/${VERSION} resolves)"
fi

# --- create annotated tag on HEAD --------------------------------------------

MSG_FILE="${RELEASE_TAG_MESSAGE_FILE:-}"
if [ -n "$MSG_FILE" ]; then
    # The message file must be a repo-relative path that canonicalizes to a
    # location under the repo root. This prevents an arbitrary readable file
    # outside the repo (e.g. an absolute /home/<user>/.ssh/id_rsa path) from
    # being embedded into the pushed tag annotation via `git tag -a -F`.
    #
    # 1. Reject absolute paths (leading `/`).
    case "$MSG_FILE" in
        /*) refuse "RELEASE_TAG_MESSAGE_FILE must be repo-relative, not absolute: $MSG_FILE" ;;
    esac
    # 2. Reject any `..` path component (parent-dir traversal / escape).
    #    Wrapping the path in slashes catches bare `..`, leading `../foo`,
    #    trailing `foo/..`, and interior `foo/../bar`, while leaving literal
    #    names like `..bar` or `foo...bar` untouched.
    case "/${MSG_FILE}/" in
        */../*) refuse "RELEASE_TAG_MESSAGE_FILE must not contain '..' components: $MSG_FILE" ;;
    esac
    # 3. Canonicalize and confirm the result stays under the repo root. This
    #    also defends against symlink escape (e.g. `tmp/link -> /etc`). Route
    #    failures through `refuse` so `set -euo pipefail` does not abort.
    REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || refuse "could not resolve repo root (git rev-parse --show-toplevel failed)"
    MSG_CANON=$(realpath -m "${REPO_ROOT}/${MSG_FILE}" 2>/dev/null) || refuse "could not canonicalize RELEASE_TAG_MESSAGE_FILE path (realpath failed): $MSG_FILE"
    case "$MSG_CANON" in
        "${REPO_ROOT}/"*) : ;;
        *) refuse "RELEASE_TAG_MESSAGE_FILE must canonicalize under the repo root: $MSG_FILE" ;;
    esac
    # Only after the path is proven safe, use it if present; otherwise fall
    # back to the minimal `Release <version>` message (preserves original
    # unset/missing semantics).
    if [ -f "$MSG_FILE" ]; then
        git tag -a "$VERSION" "$HEAD_SHA" -F "$MSG_FILE"
    else
        git tag -a "$VERSION" "$HEAD_SHA" -m "Release ${VERSION}"
    fi
else
    # Minimal internal message. No external temp file needed.
    git tag -a "$VERSION" "$HEAD_SHA" -m "Release ${VERSION}"
fi

# --- push ONLY the single tag ------------------------------------------------

PUSHED=0
PUSH_ERR=""
if git push origin "refs/tags/${VERSION}" 2>push.err; then
    PUSHED=1
else
    # Push failed: the tag was created locally but not pushed. Surface the error
    # so the operator can push manually or delete the local tag. Leave the local
    # tag in place (deleting it automatically could mask the failure).
    PUSH_ERR=$(sed -e 's/\\/\\\\/g' -e "s/\"/'/g" push.err 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')
    PUSH_ERR="git push failed (local tag ${VERSION} was created but NOT pushed): ${PUSH_ERR}"
fi
rm -f push.err

if [ "$PUSHED" = "1" ]; then
    emit_json 1 "$VERSION" "$HEAD_SHA" 1 ""
else
    emit_json 0 "$VERSION" "$HEAD_SHA" 0 "$PUSH_ERR"
fi
