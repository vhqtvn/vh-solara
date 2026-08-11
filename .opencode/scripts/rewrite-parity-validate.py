#!/usr/bin/env python3
# rewrite-parity-validate.py - structural + stage validator for the
# rewrite-parity contract gate (OPT-D two-stage hybrid gate).
#
# A rewrite-parity contract governs an EXPLICITLY-DECLARED deletion or rewrite
# slice (mode: deletion_replacement | modification_only_rewrite). It is OPT-IN:
# ordinary deletes/refactors/renames carry NO rewrite-parity burden. A contract
# is supplied explicitly (commit-gate --rewrite-parity-contract) and lives as
# versioned JSON, canonically inside a fenced ```rewrite-parity block in durable
# markdown (closeout reports, checkpoints).
#
# This script is the REFERENCE implementation. The closeout transition
# (state-lib.js, JS) and the doctor structural audit (Go) mirror its structural
# core. The three implementations aim for structural-rule-equivalence against
# one frozen v1 schema; the JS mirror is pinned to all 9 golden fixtures under
# tests/fixtures/rewrite-parity/, while this python reference and the Go mirror
# cover the same structural rules via inline test cases. Cross-language
# fixture-driver parity is a tracked follow-up (defer-rp-fixture-parity), not a
# present claim — do not assume fixture-for-fixture identity.
#
# TWO STAGES (mirrors behavioral-closure's authority split):
#   Stage 1 (commit-gate, precommit): mechanical precheck with the tree in
#     hand - structural validity + revision-binding + tree-bound cross-check +
#     a planned verifier per behavior. Rejects missing/malformed/mismatched.
#   Stage 2 (closeout transition, completion): every behavior proven with a
#     non-empty receipt (structural completeness; tree-binding honesty is
#     author + reviewer). Refuses completion on planned/failed/skipped/
#     not-demonstrable/missing-receipt.
# doctor runs the structural core only (defense-in-depth audit of committed
# artifacts; not the sole authority).
#
# not-demonstrable -> inconclusive -> blocks completed (aligns behavioral-
# closure): a behavior whose verified seam cannot observe the outcome is
# not-demonstrable, which fails the completion gate and routes to defer.
#
# Usage:
#   rewrite-parity-validate.py --contract-file <path> \
#       [--stage structural|precommit|completion] \
#       [--diff-files <json>] [--head-at-acquire <sha>]
#   rewrite-parity-validate.py --contract-json '<json>' [...]
#   echo '<json>' | rewrite-parity-validate.py --contract-stdin [...]
#
# --contract-file: raw JSON file OR a markdown file whose FIRST
#   ```rewrite-parity fenced block carries the JSON.
# --stage:
#   structural  - schema + enums only (the shared core; doctor mirrors this).
#   precommit   - structural + revision-binding + tree-bound cross-check +
#                 verifier-present per behavior (Stage 1, commit-gate).
#   completion  - structural + every-behavior-proven + receipt-present
#                 (Stage 2, closeout transition).
# --diff-files: JSON array [{"status","path"}] from the acquire-time git diff
#   (required for the precommit cross-check). Renames appear as status "Rxxx"
#   with path "old\tnew" (the gate splits name-status on the first tab only);
#   the source path counts as removed.
# --head-at-acquire: the HEAD sha captured at acquire (required for precommit
#   revision-binding).
#
# Output (single JSON object to stdout):
#   {"valid": bool, "errors": [str], "warnings": [str], "contract": {...}|null}
# Exit code: 0 if valid, 1 if invalid, 2 on usage/IO error.

import argparse
import json
import os
import re
import sys

VALID_MODES = ("deletion_replacement", "modification_only_rewrite")
VALID_RESULTS = ("planned", "proven", "failed", "skipped", "not-demonstrable")

_FENCE_RE = re.compile(r"```rewrite-parity[ \t]*\n(.*?)\n```", re.DOTALL)


def _ne_str(x):
    return isinstance(x, str) and x.strip() != ""


def extract_contract(raw_text):
    """Return (contract, error). Try raw JSON, then the first fenced block."""
    raw = raw_text.strip()
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj, None
        return None, "contract JSON is not an object (got %s)" % type(obj).__name__
    except (ValueError, json.JSONDecodeError):
        pass
    m = _FENCE_RE.search(raw)
    if m:
        try:
            return json.loads(m.group(1)), None
        except (ValueError, json.JSONDecodeError) as e:
            return None, "rewrite-parity fence found but its JSON is malformed: %s" % e
    return None, "no rewrite-parity contract found (input is neither raw JSON nor a ```rewrite-parity fence)"


def validate_structural(contract):
    """Shared structural core (all stages). Returns a list of error strings."""
    errors = []
    if not isinstance(contract, dict):
        return ["contract must be a JSON object"]

    # NOTE: a plain `!= 1` check would accept JSON `true` (Python `True == 1`).
    # Reject booleans explicitly so this mirror agrees with the JS (`!== 1`,
    # strict, where `1.0 === 1` is true) and Go (decodes to float64) validators.
    # JSON does not distinguish int/float, so integral floats (1.0) are accepted
    # by all three mirrors (they numerically equal 1); non-numeric or non-1
    # values are rejected. See the cross-language parity note in the module
    # header and TestRewriteParityCrossLanguageConformance for the binding.
    _v = contract.get("version")
    if isinstance(_v, bool) or _v != 1:
        errors.append("version must be the integer 1 (got %r)" % (_v,))
    if not _ne_str(contract.get("applies")):
        errors.append("applies must be a non-empty string")
    if contract.get("mode") not in VALID_MODES:
        errors.append("mode must be one of %s (got %r)" % (list(VALID_MODES), contract.get("mode")))

    ps = contract.get("prior_surface")
    if not isinstance(ps, dict):
        errors.append("prior_surface must be an object")
    else:
        if not _ne_str(ps.get("id")):
            errors.append("prior_surface.id must be a non-empty string")
        if not _ne_str(ps.get("revision")):
            errors.append("prior_surface.revision must be a non-empty string")
        paths = ps.get("paths")
        if not isinstance(paths, list) or len(paths) == 0:
            errors.append("prior_surface.paths must be a non-empty array")
        elif not all(_ne_str(p) for p in paths):
            errors.append("prior_surface.paths must be an array of non-empty strings")
        if not isinstance(ps.get("inventory_complete"), bool):
            errors.append("prior_surface.inventory_complete must be a boolean")

    behaviors = contract.get("behaviors")
    if not isinstance(behaviors, list) or len(behaviors) == 0:
        errors.append("behaviors must be a non-empty array")
        behaviors = []
    seen = set()
    for i, b in enumerate(behaviors):
        pfx = "behaviors[%d]" % i
        if not isinstance(b, dict):
            errors.append("%s must be an object" % pfx)
            continue
        bid = b.get("id")
        if not _ne_str(bid):
            errors.append("%s.id must be a non-empty string" % pfx)
        elif bid in seen:
            errors.append("%s.id %r is duplicated within this contract" % (pfx, bid))
        else:
            seen.add(bid)
        if not _ne_str(b.get("description")):
            errors.append("%s.description must be a non-empty string" % pfx)
        pe = b.get("prior_evidence")
        if not isinstance(pe, list) or len(pe) == 0:
            errors.append("%s.prior_evidence must be a non-empty array" % pfx)
        elif not all(_ne_str(e) for e in pe):
            errors.append("%s.prior_evidence must be an array of non-empty strings" % pfx)
        ver = b.get("verifier")
        if not isinstance(ver, dict):
            errors.append("%s.verifier must be an object" % pfx)
        else:
            if not _ne_str(ver.get("kind")):
                errors.append("%s.verifier.kind must be a non-empty string" % pfx)
            if not _ne_str(ver.get("locator")):
                errors.append("%s.verifier.locator must be a non-empty string" % pfx)
        res = b.get("result")
        if not isinstance(res, dict):
            errors.append("%s.result must be an object" % pfx)
        else:
            if res.get("status") not in VALID_RESULTS:
                errors.append("%s.result.status must be one of %s (got %r)" % (pfx, list(VALID_RESULTS), res.get("status")))
            for k in ("receipt", "note"):
                v = res.get(k)
                if v is not None and not _ne_str(v):
                    errors.append("%s.result.%s must be a non-empty string when present" % (pfx, k))
    return errors


def _diff_sets(diff_files):
    """From [{"status","path"}] compute (removed_set, modified_set).

    removed = status D, or R-source (rename old path). modified = status M.
    Renames arrive as status "Rxxx" with path "old\\tnew" because the gate
    splits name-status on the first tab only."""
    removed, modified = set(), set()
    for entry in diff_files or []:
        s = str(entry.get("status", ""))
        p = str(entry.get("path", ""))
        if s.startswith("R"):
            parts = p.split("\t", 1)
            if parts and parts[0].strip():
                removed.add(parts[0].strip())
        elif s == "D":
            if p.strip():
                removed.add(p.strip())
        elif s == "M":
            if p.strip():
                modified.add(p.strip())
    return removed, modified


def validate_precommit(contract, diff_files, head_at_acquire):
    """Stage 1: structural + revision-binding + tree-bound cross-check."""
    errors = validate_structural(contract)
    if errors:
        return errors
    ps = contract["prior_surface"]
    mode = contract["mode"]
    inv = ps["inventory_complete"]
    declared = set(p.strip() for p in ps["paths"])

    if head_at_acquire and ps.get("revision") and ps["revision"] != head_at_acquire:
        errors.append(
            "prior_surface.revision %r does not match head_at_acquire %r"
            % (ps["revision"], head_at_acquire)
        )

    if diff_files is not None:
        removed, modified = _diff_sets(diff_files)
        if mode == "deletion_replacement":
            target, label = removed, "deleted"
        else:
            target, label = modified, "modified"
        if inv:
            undeclared = target - declared
            nontarget = declared - target
            if undeclared:
                errors.append(
                    "inventory_complete=true but %d %s path(s) are absent from "
                    "prior_surface.paths (undeclared): %s"
                    % (len(undeclared), label, sorted(undeclared))
                )
            if nontarget:
                errors.append(
                    "inventory_complete=true but %d declared prior_surface.path(s) "
                    "are not %s: %s"
                    % (len(nontarget), label, sorted(nontarget))
                )
        else:
            nontarget = declared - target
            if nontarget:
                errors.append(
                    "%d declared prior_surface.path(s) are not %s: %s"
                    % (len(nontarget), label, sorted(nontarget))
                )
    return errors


def validate_completion(contract):
    """Stage 2: structural + every-behavior-proven + receipt-present."""
    errors = validate_structural(contract)
    if errors:
        return errors
    for i, b in enumerate(contract["behaviors"]):
        pfx = "behaviors[%d]" % i
        res = b.get("result", {})
        st = res.get("status")
        if st != "proven":
            errors.append(
                "%s.result.status is %r; completion (status=completed) requires "
                "every behavior proven (planned/failed/skipped/not-demonstrable "
                "block completion - not-demonstrable routes to defer)" % (pfx, st)
            )
            continue
        if not _ne_str(res.get("receipt")):
            errors.append(
                "%s.result.status is proven but result.receipt is missing or empty "
                "(a non-empty receipt locator is required for a proven behavior at "
                "completion; the tree-binding honesty is author + reviewer, "
                "mirroring behavioral-closure)" % pfx
            )
    return errors


def main(argv):
    p = argparse.ArgumentParser(
        prog="rewrite-parity-validate.py",
        description="Validate a rewrite-parity contract (OPT-D two-stage gate).",
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--contract-file")
    src.add_argument("--contract-json")
    src.add_argument("--contract-stdin", action="store_true", help="read raw JSON from stdin")
    p.add_argument("--stage", choices=("structural", "precommit", "completion"), default="structural")
    p.add_argument("--diff-files", help="JSON array of {status,path} for the precommit cross-check")
    p.add_argument("--head-at-acquire", help="HEAD sha at acquire time (precommit revision-binding)")
    args = p.parse_args(argv)

    raw_text = None
    if args.contract_file:
        try:
            with open(args.contract_file, "r", encoding="utf-8") as f:
                raw_text = f.read()
        except OSError as e:
            print(json.dumps({"valid": False, "errors": ["cannot read contract file: %s" % e], "contract": None}))
            return 2
    elif args.contract_json:
        raw_text = args.contract_json
    else:
        raw_text = sys.stdin.read()

    contract, extract_err = extract_contract(raw_text)
    if extract_err:
        print(json.dumps({"valid": False, "errors": [extract_err], "contract": None}))
        return 1

    diff_files = None
    if args.diff_files is not None:
        try:
            diff_files = json.loads(args.diff_files)
            if not isinstance(diff_files, list):
                raise ValueError("not an array")
        except (ValueError, json.JSONDecodeError) as e:
            print(json.dumps({"valid": False, "errors": ["--diff-files is not a JSON array: %s" % e], "contract": contract}))
            return 2

    if args.stage == "precommit":
        errors = validate_precommit(contract, diff_files, args.head_at_acquire)
    elif args.stage == "completion":
        errors = validate_completion(contract)
    else:
        errors = validate_structural(contract)

    out = {"valid": len(errors) == 0, "errors": errors, "warnings": [], "contract": contract}
    print(json.dumps(out))
    return 0 if not errors else 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
