"""
Tier cascade state machine for commit review.

This module implements the deterministic tier-cascade logic that the
commit-reviewer orchestrator prompt describes. It is used:
1. As a reference implementation for the orchestrator prompt
2. As testable code to validate the state machine independently

The orchestrator prompt is the primary runtime — this module exists to
prove the logic is sound and to catch edge cases.

CGD Phase-1: Added disposition-aware aggregation, cross-leaf DISAGREEMENT
resolution, and resolved-categories tracking.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


class Verdict(str, Enum):
    APPROVE = "approve"
    BLOCKED = "blocked"
    SPLIT = "split"


class Confidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Risk(str, Enum):
    HIGH = "high"
    MODERATE = "moderate"
    LOW = "low"


class Disposition(str, Enum):
    BLOCK = "block"
    DEFER = "defer"
    DROP = "drop"


CONFIDENCE_ORDER = {"high": 3, "medium": 2, "low": 1}
RISK_ORDER = {"high": 3, "moderate": 2, "low": 1}


@dataclass
class LeafResult:
    leaf_key: str
    verdict: Verdict
    confidence: Confidence
    risk: Risk
    issue_count: int = 0
    blocking_issues: list[dict] = field(default_factory=list)
    followups: list[dict] = field(default_factory=list)
    findings: list[dict] = field(default_factory=list)
    reviewed_files: list[str] = field(default_factory=list)
    split_reason: Optional[str] = None
    validation_notes: str = ""
    failed: bool = False


@dataclass
class TierConfig:
    name: str
    leaves: list[str]
    disabled: bool = False
    within_tier_aggregation: str = "strict_consensus"


@dataclass
class LightweightReviewConfig:
    doc_globs: list[str]
    mode: str  # "single_leaf"
    leaf_selector: str  # "first"

    SUPPORTED_MODES = {"single_leaf"}
    SUPPORTED_SELECTORS = {"first"}


def _path_aware_match(file_path: str, pattern: str) -> bool:
    """Match a file path against a glob pattern treating ``/`` as a separator.

    Unlike :func:`fnmatch.fnmatch`, this function treats ``/`` as a path
    separator so that:

    * ``*.md`` only matches root-level files (no ``/`` in *file_path*).
    * ``docs/**/*.md`` matches ``.md`` files at any depth under ``docs/``.
    * ``docs/*.md`` matches only direct children of ``docs/``.
    """
    path_parts = file_path.split("/")
    pattern_parts = pattern.split("/")
    return _match_segments(path_parts, 0, pattern_parts, 0)


def _match_segments(
    path_parts: list[str],
    pi: int,
    pattern_parts: list[str],
    qi: int,
) -> bool:
    """Recursive segment-aware glob match."""
    # Both exhausted -> match
    if qi == len(pattern_parts):
        return pi == len(path_parts)
    # Path exhausted -> remaining pattern parts must all be **
    if pi == len(path_parts):
        return all(p == "**" for p in pattern_parts[qi:])

    pat = pattern_parts[qi]

    if pat == "**":
        # ** matches zero or more path segments
        # Try consuming zero segments (skip **) first
        if _match_segments(path_parts, pi, pattern_parts, qi + 1):
            return True
        # Try consuming one segment, keeping ** active
        return _match_segments(path_parts, pi + 1, pattern_parts, qi)
    else:
        # Normal segment — use fnmatch for wildcards within the segment
        if fnmatch.fnmatch(path_parts[pi], pat):
            return _match_segments(path_parts, pi + 1, pattern_parts, qi + 1)
        return False


@dataclass
class CascadeConfig:
    tiers: list[TierConfig]
    schema_version: int = 1
    fail_fast: bool = True
    escalation_policy: str = "all_approve"
    findings_combination: str = "merge_across_tiers"
    lightweight_review: Optional[LightweightReviewConfig] = None

    SUPPORTED_SCHEMA_VERSIONS = {1, 2}
    SUPPORTED_ESCALATION_POLICIES = {"all_approve"}
    SUPPORTED_FINDINGS_COMBINATIONS = {"merge_across_tiers"}
    SUPPORTED_WITHIN_TIER_AGGREGATIONS = {"strict_consensus"}

    @classmethod
    def from_file(cls, path: str | Path) -> CascadeConfig:
        with open(path) as f:
            data = json.load(f)

        schema_version = data.get("schema_version", 1)
        if schema_version not in cls.SUPPORTED_SCHEMA_VERSIONS:
            raise ValueError(
                f"Unsupported review-tiers.json schema_version: {schema_version}. "
                f"Expected one of {cls.SUPPORTED_SCHEMA_VERSIONS}."
            )

        fail_fast = data.get("fail_fast", True)
        escalation_policy = data.get("escalation_policy", "all_approve")
        findings_combination = data.get("findings_combination", "merge_across_tiers")

        # Type guards — reject wrong JSON types that would silently misbehave
        if not isinstance(fail_fast, bool):
            raise ValueError(
                f"Config field 'fail_fast' must be a boolean, got {type(fail_fast).__name__}: {fail_fast!r}"
            )
        if not isinstance(escalation_policy, str):
            raise ValueError(
                f"Config field 'escalation_policy' must be a string, got {type(escalation_policy).__name__}"
            )
        if not isinstance(findings_combination, str):
            raise ValueError(
                f"Config field 'findings_combination' must be a string, got {type(findings_combination).__name__}"
            )

        if escalation_policy not in cls.SUPPORTED_ESCALATION_POLICIES:
            raise ValueError(
                f"Unsupported escalation_policy: {escalation_policy}. "
                f"Supported: {cls.SUPPORTED_ESCALATION_POLICIES}."
            )
        if findings_combination not in cls.SUPPORTED_FINDINGS_COMBINATIONS:
            raise ValueError(
                f"Unsupported findings_combination: {findings_combination}. "
                f"Supported: {cls.SUPPORTED_FINDINGS_COMBINATIONS}."
            )

        tiers = []
        for t in data.get("tiers", []):
            agg = t.get("within_tier_aggregation", "strict_consensus")
            if agg not in cls.SUPPORTED_WITHIN_TIER_AGGREGATIONS:
                raise ValueError(
                    f"Unsupported within_tier_aggregation: {agg}. "
                    f"Supported: {cls.SUPPORTED_WITHIN_TIER_AGGREGATIONS}."
                )
            leaves = t["leaves"]
            # Type guard: leaves must be a list of strings
            if not isinstance(leaves, list):
                raise ValueError(
                    f"Tier '{t['name']}' field 'leaves' must be an array, got {type(leaves).__name__}"
                )
            if not all(isinstance(lf, str) for lf in leaves):
                raise ValueError(
                    f"Tier '{t['name']}' field 'leaves' must be an array of strings"
                )
            if not leaves:
                raise ValueError(
                    f"Tier '{t['name']}' has no leaves. Each tier must have at least one leaf."
                )
            disabled = t.get("disabled", False)
            if not isinstance(disabled, bool):
                raise ValueError(
                    f"Tier '{t['name']}' field 'disabled' must be a boolean, got {type(disabled).__name__}: {disabled!r}"
                )
            tiers.append(TierConfig(
                name=t["name"],
                leaves=leaves,
                disabled=disabled,
                within_tier_aggregation=agg,
            ))
        active_tiers = [t for t in tiers if not t.disabled and len(t.leaves) > 0]
        if len(active_tiers) == 0:
            raise ValueError(
                "Config must have at least one active tier with at least one leaf."
            )

        # Parse optional lightweight_review section
        lightweight_review: Optional[LightweightReviewConfig] = None
        lw_data = data.get("lightweight_review")
        if lw_data is not None:
            if not isinstance(lw_data, dict):
                raise ValueError(
                    f"Config field 'lightweight_review' must be an object, "
                    f"got {type(lw_data).__name__}"
                )
            doc_globs = lw_data.get("doc_globs")
            mode = lw_data.get("mode", "single_leaf")
            leaf_selector = lw_data.get("leaf_selector", "first")

            # Type guards
            if not isinstance(doc_globs, list):
                raise ValueError(
                    f"lightweight_review.doc_globs must be an array, "
                    f"got {type(doc_globs).__name__}"
                )
            if not all(isinstance(g, str) for g in doc_globs):
                raise ValueError(
                    "lightweight_review.doc_globs must be an array of strings"
                )
            if not isinstance(mode, str):
                raise ValueError(
                    f"lightweight_review.mode must be a string, "
                    f"got {type(mode).__name__}"
                )
            if not isinstance(leaf_selector, str):
                raise ValueError(
                    f"lightweight_review.leaf_selector must be a string, "
                    f"got {type(leaf_selector).__name__}"
                )

            if mode not in LightweightReviewConfig.SUPPORTED_MODES:
                raise ValueError(
                    f"Unsupported lightweight_review.mode: {mode}. "
                    f"Supported: {LightweightReviewConfig.SUPPORTED_MODES}."
                )
            if leaf_selector not in LightweightReviewConfig.SUPPORTED_SELECTORS:
                raise ValueError(
                    f"Unsupported lightweight_review.leaf_selector: {leaf_selector}. "
                    f"Supported: {LightweightReviewConfig.SUPPORTED_SELECTORS}."
                )

            lightweight_review = LightweightReviewConfig(
                doc_globs=doc_globs,
                mode=mode,
                leaf_selector=leaf_selector,
            )

        return cls(
            schema_version=schema_version,
            tiers=tiers,
            fail_fast=fail_fast,
            escalation_policy=escalation_policy,
            findings_combination=findings_combination,
            lightweight_review=lightweight_review,
        )

    def should_use_lightweight_review(self, changed_files: list[str]) -> bool:
        """Return True if all changed files match at least one lightweight doc glob.

        Uses path-separator-aware matching so that ``*.md`` only matches
        root-level files, ``docs/**/*.md`` matches at any depth under
        ``docs/``, and ``docs/*.md`` matches only direct children of ``docs/``.
        """
        if not self.lightweight_review:
            return False
        if not changed_files:
            return False
        for f in changed_files:
            if not any(_path_aware_match(f, glob) for glob in self.lightweight_review.doc_globs):
                return False
        return True


@dataclass
class CascadeResult:
    verdict: Verdict
    confidence: Confidence
    risk: Risk
    blocking_issues: list[dict]
    followups: list[dict]
    reviewed_files: list[str]
    split_reason: Optional[str]
    validation_notes: str
    tiers_executed: list[str]
    tiers_skipped: list[str]
    leaf_results: dict[str, dict]
    lightweight: bool = False
    findings: list[dict] = field(default_factory=list)
    deferred_findings: list[str] = field(default_factory=list)
    dropped_findings: list[str] = field(default_factory=list)
    resolved_categories: dict[str, int] = field(default_factory=dict)


def _lower_confidence(c1: Confidence, c2: Confidence) -> Confidence:
    return c1 if CONFIDENCE_ORDER[c1.value] <= CONFIDENCE_ORDER[c2.value] else c2


def _higher_risk(r1: Risk, r2: Risk) -> Risk:
    return r1 if RISK_ORDER[r1.value] >= RISK_ORDER[r2.value] else r2


def _dedupe_issues(issues: list[dict]) -> list[dict]:
    """Deduplicate issues by (location + issue text) or by (text) for followups, preserving order."""
    seen: set[str] = set()
    deduped: list[dict] = []
    for issue in issues:
        # Blocking issues have location+issue; followups have text
        key = f"{issue.get('location', '')}|{issue.get('issue', '')}|{issue.get('text', '')}"
        if key not in seen:
            seen.add(key)
            deduped.append(issue)
    return deduped


def _has_verifiable_evidence(finding: dict) -> bool:
    """Check if a BLOCK finding has diff-verifiable evidence.

    Returns True only if the finding has a complete evidence object with
    type, reference, and description fields.
    """
    evidence = finding.get("evidence")
    if not isinstance(evidence, dict):
        return False
    return (
        bool(evidence.get("type"))
        and bool(evidence.get("reference"))
        and bool(evidence.get("description"))
    )


def _findings_dedup_key(finding: dict) -> str:
    """Generate a dedup key for a finding."""
    return f"{finding.get('id', '')}|{finding.get('location', '')}|{finding.get('issue', '')}"


def resolve_disagreement(
    tier_results: list[LeafResult],
) -> tuple[list[dict], list[str]]:
    """Resolve cross-leaf DISAGREEMENT for BLOCK findings.

    For each BLOCK finding claimed by one leaf but not others:
    - If the BLOCK-claimer's evidence is diff-verifiable -> BLOCK stands
    - If evidence is MISSING or not diff-verifiable -> DOWNGRADE to drop

    Returns (all_resolved_findings, notes).
    """
    if len(tier_results) <= 1:
        # Single leaf — no disagreement possible
        findings: list[dict] = []
        for lr in tier_results:
            findings.extend(lr.findings)
        return findings, []

    # Collect all findings from all leaves, grouped by approximate location+issue
    all_findings: list[dict] = []
    block_claims: dict[str, list[tuple[dict, str]]] = {}  # dedup_key -> [(finding, leaf_key)]
    notes: list[str] = []

    for lr in tier_results:
        for f in lr.findings:
            all_findings.append(f)
            if f.get("disposition") == Disposition.BLOCK.value:
                key = _findings_dedup_key(f)
                if key not in block_claims:
                    block_claims[key] = []
                block_claims[key].append((f, lr.leaf_key))

    # Check each BLOCK claim for disagreement
    resolved: list[dict] = []
    seen_keys: set[str] = set()

    for f in all_findings:
        key = _findings_dedup_key(f)
        if key in seen_keys:
            continue
        seen_keys.add(key)

        if f.get("disposition") != Disposition.BLOCK.value:
            resolved.append(f)
            continue

        # This is a BLOCK finding — check for disagreement
        claimers = block_claims.get(key, [])
        claimer_keys = set(lk for _, lk in claimers)

        if len(claimer_keys) < len(tier_results):
            # Disagreement: not all leaves agree this should block
            # Check if the BLOCK-claimer's evidence is verifiable
            if _has_verifiable_evidence(f):
                # Evidence is verifiable -> BLOCK stands
                notes.append(
                    f"BLOCK finding {f.get('id', '?')}: evidence verified, stands "
                    f"(claimed by {', '.join(claimer_keys)})"
                )
                resolved.append(f)
            else:
                # Evidence not verifiable -> DOWNGRADE to drop
                f_copy = dict(f)
                f_copy["disposition"] = Disposition.DROP.value
                f_copy["original_disposition"] = Disposition.BLOCK.value
                f_copy["downgrade_reason"] = "evidence not diff-verifiable, cross-leaf disagreement"
                notes.append(
                    f"BLOCK finding {f.get('id', '?')}: evidence not diff-verifiable, "
                    f"downgraded to advisory (claimed by {', '.join(claimer_keys)})"
                )
                resolved.append(f_copy)
        else:
            # All leaves agree on BLOCK -> stands
            resolved.append(f)

    return resolved, notes


def aggregate_within_tier(leaf_results: list[LeafResult]) -> tuple[Verdict, Confidence, Risk]:
    """Aggregate leaf results within a single tier using disposition-aware strict consensus.

    Gates on BLOCK findings only. DEFER and DROP never affect the verdict.
    """
    if not leaf_results:
        return Verdict.BLOCKED, Confidence.LOW, Risk.HIGH

    # Check for any surviving BLOCK findings after disagreement resolution
    has_block = False
    for lr in leaf_results:
        for f in lr.findings:
            if f.get("disposition") == Disposition.BLOCK.value:
                has_block = True
                break
        if has_block:
            break

    # Also check verdict field from leaf (covers both v1 blocking_issues
    # and v2 disposition findings — the leaf's verdict is authoritative)
    if not has_block:
        verdicts = [lr.verdict for lr in leaf_results]
        has_block = any(v == Verdict.BLOCKED for v in verdicts)

    if has_block:
        verdict = Verdict.BLOCKED
    elif any(lr.verdict == Verdict.SPLIT for lr in leaf_results):
        verdict = Verdict.SPLIT
    else:
        verdict = Verdict.APPROVE

    # Confidence: lowest
    confidence = leaf_results[0].confidence
    for lr in leaf_results[1:]:
        confidence = _lower_confidence(confidence, lr.confidence)

    # Risk: highest
    risk = leaf_results[0].risk
    for lr in leaf_results[1:]:
        risk = _higher_risk(risk, lr.risk)

    return verdict, confidence, risk


def run_cascade(
    config: CascadeConfig,
    leaf_simulator: dict[str, LeafResult],
    changed_files: list[str] | None = None,
) -> CascadeResult:
    """
    Run the tiered cascade state machine.

    leaf_simulator maps leaf names (e.g. "commit-reviewer-b") to their
    simulated results. Missing leaves are treated as failed.

    changed_files is optional. If provided and all files match the
    lightweight_review doc_globs, the cascade is replaced by a single-leaf
    result with lightweight=True.
    """
    # Step 0: Lightweight review check
    if changed_files is not None and config.should_use_lightweight_review(changed_files):
        # Find the first leaf from the first active tier
        for tier in config.tiers:
            if not tier.disabled and tier.leaves:
                leaf_name = tier.leaves[0]
                if leaf_name in leaf_simulator:
                    lr = leaf_simulator[leaf_name]
                else:
                    lr = LeafResult(
                        leaf_key="lightweight",
                        verdict=Verdict.BLOCKED,
                        confidence=Confidence.LOW,
                        risk=Risk.HIGH,
                        failed=True,
                        blocking_issues=[{
                            "category": "correctness",
                            "location": "orchestrator",
                            "issue": f"Lightweight leaf {leaf_name} returned non-parseable or missing output",
                            "suggestion": "Re-run the review.",
                        }],
                    )
                # Extract findings with dispositions
                lw_findings = lr.findings if lr.findings else []
                blocking_ids = [f.get("id", "?") for f in lw_findings if f.get("disposition") == Disposition.BLOCK.value]
                deferred_ids = [f.get("id", "?") for f in lw_findings if f.get("disposition") == Disposition.DEFER.value]
                dropped_ids = [f.get("id", "?") for f in lw_findings if f.get("disposition") == Disposition.DROP.value]

                return CascadeResult(
                    verdict=lr.verdict,
                    confidence=lr.confidence,
                    risk=lr.risk,
                    blocking_issues=lr.blocking_issues,
                    followups=lr.followups,
                    reviewed_files=lr.reviewed_files,
                    split_reason=lr.split_reason,
                    validation_notes=lr.validation_notes or "Lightweight single-leaf review",
                    tiers_executed=[tier.name],
                    tiers_skipped=[t.name for t in config.tiers if t.name != tier.name],
                    leaf_results={"lightweight": {
                        "verdict": lr.verdict.value,
                        "confidence": lr.confidence.value,
                        "risk": lr.risk.value,
                        "issue_count": lr.issue_count,
                        "blocking_count": len(blocking_ids),
                        "deferred_count": len(deferred_ids),
                        "dropped_count": len(dropped_ids),
                    }},
                    lightweight=True,
                    findings=lw_findings,
                    deferred_findings=deferred_ids,
                    dropped_findings=dropped_ids,
                )

    combined_blocking: list[dict] = []
    combined_followups: list[dict] = []
    combined_findings: list[dict] = []
    combined_files: set[str] = set()
    combined_notes: list[str] = []
    all_leaf_results: dict[str, dict] = {}
    tiers_executed: list[str] = []
    tiers_skipped: list[str] = []
    overall_confidence = Confidence.HIGH
    overall_risk = Risk.LOW
    split_reasons: list[str] = []
    worst_verdict = Verdict.APPROVE  # tracks worst verdict across tiers when fail_fast=False
    resolved_categories: dict[str, int] = {}

    for tier_idx, tier in enumerate(config.tiers):
        if tier.disabled:
            tiers_skipped.append(tier.name)
            continue

        # Gather results for this tier's leaves
        tier_results: list[LeafResult] = []
        for leaf_idx, leaf_name in enumerate(tier.leaves):
            leaf_letter = leaf_name[-1]  # e.g. "commit-reviewer-b" -> "b"
            leaf_key = f"tier{tier_idx + 1}_{leaf_letter}"

            if leaf_name in leaf_simulator:
                lr = leaf_simulator[leaf_name]
                lr.leaf_key = leaf_key
            else:
                # Leaf not provided — treat as failed
                lr = LeafResult(
                    leaf_key=leaf_key,
                    verdict=Verdict.BLOCKED,
                    confidence=Confidence.LOW,
                    risk=Risk.HIGH,
                    failed=True,
                    blocking_issues=[{
                        "category": "correctness",
                        "location": "orchestrator",
                        "issue": f"Leaf {leaf_key} returned non-parseable or missing output",
                        "suggestion": "Re-run the review.",
                    }],
                )

            tier_results.append(lr)
            blocking_count = sum(1 for f in lr.findings if f.get("disposition") == Disposition.BLOCK.value)
            deferred_count = sum(1 for f in lr.findings if f.get("disposition") == Disposition.DEFER.value)
            dropped_count = sum(1 for f in lr.findings if f.get("disposition") == Disposition.DROP.value)

            leaf_dict = {
                "verdict": lr.verdict.value,
                "confidence": lr.confidence.value,
                "risk": lr.risk.value,
                "issue_count": lr.issue_count,
                "blocking_count": blocking_count,
                "deferred_count": deferred_count,
                "dropped_count": dropped_count,
            }
            if lr.failed:
                leaf_dict["failed"] = True
            all_leaf_results[leaf_key] = leaf_dict

        # Resolve cross-leaf disagreements for this tier
        resolved_findings, disagreement_notes = resolve_disagreement(tier_results)
        if disagreement_notes:
            combined_notes.extend(disagreement_notes)

        # resolved_findings already contains the correct dispositions after disagreement resolution
        surviving_block = any(
            f.get("disposition") == Disposition.BLOCK.value for f in resolved_findings
        )
        # Update each leaf's findings to the resolved set so aggregate_within_tier
        # sees the correct (post-resolution) dispositions
        for lr in tier_results:
            lr.findings = resolved_findings

        # Aggregate within tier (disposition-aware)
        tier_verdict, tier_confidence, tier_risk = aggregate_within_tier(tier_results)

        # Override tier_verdict based on resolved findings (authoritative for block)
        if surviving_block:
            tier_verdict = Verdict.BLOCKED
        elif disagreement_notes and tier_verdict == Verdict.BLOCKED:
            # Disagreement resolution removed all blocks — clear stale BLOCKED
            tier_verdict = Verdict.APPROVE

        tiers_executed.append(tier.name)
        overall_confidence = _lower_confidence(overall_confidence, tier_confidence)
        overall_risk = _higher_risk(overall_risk, tier_risk)

        # Merge findings from resolved set
        combined_findings.extend(resolved_findings)

        # Merge legacy fields (backward compat)
        for lr in tier_results:
            combined_blocking.extend(lr.blocking_issues)
            combined_followups.extend(lr.followups)
            combined_files.update(lr.reviewed_files)
            if lr.validation_notes:
                combined_notes.append(f"[{lr.leaf_key}] {lr.validation_notes}")
            if lr.split_reason:
                split_reasons.append(f"[{lr.leaf_key}] {lr.split_reason}")

        # Deduplicate
        combined_blocking = _dedupe_issues(combined_blocking)
        combined_followups = _dedupe_issues(combined_followups)

        # Track resolved categories for this tier
        if tier_verdict == Verdict.APPROVE:
            categories_in_tier = set()
            for f in resolved_findings:
                cat = f.get("category", "")
                if cat:
                    categories_in_tier.add(cat)
            for cat in categories_in_tier:
                resolved_categories[cat] = resolved_categories.get(cat, 0) + 1

        # Check escalation
        if config.fail_fast:
            # Fail-fast: stop immediately on block or split
            if tier_verdict == Verdict.BLOCKED:
                return CascadeResult(
                    verdict=Verdict.BLOCKED,
                    confidence=overall_confidence,
                    risk=overall_risk,
                    blocking_issues=combined_blocking,
                    followups=combined_followups,
                    reviewed_files=sorted(combined_files),
                    split_reason=None,
                    validation_notes="\n".join(combined_notes),
                    tiers_executed=tiers_executed,
                    tiers_skipped=tiers_skipped,
                    leaf_results=all_leaf_results,
                    findings=combined_findings,
                    deferred_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DEFER.value],
                    dropped_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DROP.value],
                    resolved_categories=resolved_categories,
                )
            elif tier_verdict == Verdict.SPLIT:
                return CascadeResult(
                    verdict=Verdict.SPLIT,
                    confidence=overall_confidence,
                    risk=overall_risk,
                    blocking_issues=combined_blocking,
                    followups=combined_followups,
                    reviewed_files=sorted(combined_files),
                    split_reason="; ".join(split_reasons),
                    validation_notes="\n".join(combined_notes),
                    tiers_executed=tiers_executed,
                    tiers_skipped=tiers_skipped,
                    leaf_results=all_leaf_results,
                    findings=combined_findings,
                    deferred_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DEFER.value],
                    dropped_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DROP.value],
                    resolved_categories=resolved_categories,
                )
        else:
            # Non-fail-fast: track worst verdict, continue to next tier
            if tier_verdict == Verdict.BLOCKED:
                worst_verdict = Verdict.BLOCKED  # blocked is always worst
            elif tier_verdict == Verdict.SPLIT and worst_verdict != Verdict.BLOCKED:
                worst_verdict = Verdict.SPLIT
            # continue to next tier regardless

    # All tiers executed — use worst_verdict for non-fail-fast, or approve for fail-fast
    final_verdict = worst_verdict if not config.fail_fast else Verdict.APPROVE
    final_split_reason = "; ".join(split_reasons) if final_verdict == Verdict.SPLIT else None
    return CascadeResult(
        verdict=final_verdict,
        confidence=overall_confidence,
        risk=overall_risk,
        blocking_issues=combined_blocking,
        followups=combined_followups,
        reviewed_files=sorted(combined_files),
        split_reason=final_split_reason,
        validation_notes="\n".join(combined_notes),
        tiers_executed=tiers_executed,
        tiers_skipped=tiers_skipped,
        leaf_results=all_leaf_results,
        findings=combined_findings,
        deferred_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DEFER.value],
        dropped_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DROP.value],
        resolved_categories=resolved_categories,
    )
