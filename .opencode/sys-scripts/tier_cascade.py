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

Bounded-B panel roster (5-seat registered pool): the module now CONSULTS the
schema_version 2 ``panel`` section for ROSTER VALIDATION and LIGHTWEIGHT
SEAT SELECTION only — ``panel.roles``, ``panel.lenses``, and
``panel.leaf_roles``. Roster validation is GATED ON PANEL PRESENCE: a
config WITHOUT a ``panel`` section (schema_version 1) skips the bounded-B
roster rules entirely and parses and dispatches identically to a pre-panel
config (custom leaf IDs, single-leaf tiers, any tier shape) — the
backward-compatibility promise the shipped config's schema-v2 comment makes.
It deliberately does NOT consume ``panel.class_ownership``
or ``panel.quorum`` for aggregation: the quorum/uphold semantics stay exactly
as specified in the orchestrator prompt (BLOCK-only gating, evidence
verifiability, strict-consensus tier verdict), so an off-focus specialist
BLOCK with verifiable evidence still upholds ``blocked`` regardless of any
seat's role. This deliberately keeps the per-class-quorum consumption
upgrade condition — this module consuming
``panel.class_ownership``/``panel.quorum`` — UNFIRED (an adopting project
tracks that condition in its own review-governance backlog; shipped core
surfaces never name a project's backlog IDs).

Config loading supports an ADDITIVE PROJECT OVERRIDE: the base config at
``.opencode/config/review-tiers.json`` (platform_managed, receives upstream
updates) is merged with ``.opencode/repo-configs/review-tiers.json`` when
that operator-owned override exists. Merge semantics: nested dicts merge
recursively with the override winning key-by-key; lists (notably ``tiers``)
and scalars are REPLACED wholesale by the override. The override is the
operator's roster lever — it never edits the managed base file.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


# The bounded-B registered leaf pool. Go registration (resolver catalog,
# permconfig tables, opencode.jsonc agent blocks) ships exactly these five
# seats; roster validation rejects any tier or leaf_roles entry naming a leaf
# outside this set. Registered != active: which subset is on duty is a
# review-tiers.json roster decision (default active = a..d = 3 generalists +
# 1 specialist; e is registered but held out via the disabled premium tier).
REGISTERED_LEAVES: tuple[str, ...] = (
    "commit-reviewer-a",
    "commit-reviewer-b",
    "commit-reviewer-c",
    "commit-reviewer-d",
    "commit-reviewer-e",
)

# Roles whose seats count as GENERALISTS for roster composition. A generalist
# covers every finding class (block_finder lens semantics); r1_backup_secondary
# is the redundant-slot backup with the same charter. Every other role
# (r2_contract_data, r3_security, r4_blind_spot) is a SPECIALIST seat.
GENERALIST_ROLES: frozenset[str] = frozenset({"r1_redundant", "r1_backup_secondary"})

# Bounded-B roster capacity constraints, enforced BEFORE any dispatch.
MIN_GENERALISTS = 2
MAX_ACTIVE_LEAVES = 5

# Canonical project override path (repo-relative). Unlisted files under
# .opencode/repo-configs/ are unmanaged, so this file is entirely the
# operator's — the harness never renders or reconciles it.
REVIEW_TIERS_OVERRIDE_PATH = ".opencode/repo-configs/review-tiers.json"

# Fixture prerequisite surfaced (never silently passed) when an operator
# configures a roster with two or more specialist seats: per-class quorum
# fixtures become DISCRIMINATING at that point (the specialist-floor
# condition — a second leaf taking a specialist role). DOMAIN-FREE by
# contract: the warning text never names an adopting project's backlog IDs;
# operators are pointed at their own review-governance records instead.
SPECIALIST_FLOOR_PREREQUISITE = (
    "roster has {n} specialist seat(s) ({leaves}): per-class quorum "
    "merge-layer fixtures become discriminating at M>=2 — the "
    "specialist-floor fixture prerequisite must be settled (consult the "
    "adopting project's review-governance backlog before activating M>=2 "
    "specialists) before relying on owner_or_redundant uphold semantics "
    "for this roster"
)


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


class ModelPreflightError(ValueError):
    """An ACTIVE leaf has no usable model file — dispatch must hard-refuse.

    Raised by :func:`preflight_models` when ``.local/config/agent-model/<leaf>``
    is missing or zero bytes for any leaf in an active tier. Model identity is
    operator-local (gitignored), so this check lives in runtime dispatch, not
    in any build-time validator.
    """


@dataclass
class LeafRole:
    role: str
    lens: str


@dataclass
class PanelConfig:
    """Parsed subset of the schema_version 2 ``panel`` section.

    ONLY the roster-relevant keys are parsed: ``roles``, ``lenses``,
    ``leaf_roles``. ``class_ownership`` and ``quorum`` are deliberately NOT
    fields here — they remain routing documentation consumed by the
    orchestrator prompt, never by aggregation (see module docstring).
    """

    roles: dict[str, dict] = field(default_factory=dict)
    lenses: dict[str, dict] = field(default_factory=dict)
    leaf_roles: dict[str, LeafRole] = field(default_factory=dict)

    def role_of(self, leaf: str) -> str:
        """Role of *leaf*; a leaf with no leaf_roles entry defaults to the
        r1_redundant generalist (the documented graceful fallback)."""
        entry = self.leaf_roles.get(leaf)
        return entry.role if entry else "r1_redundant"

    def is_generalist(self, leaf: str) -> bool:
        return self.role_of(leaf) in GENERALIST_ROLES


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
    panel: Optional[PanelConfig] = None

    SUPPORTED_SCHEMA_VERSIONS = {1, 2}
    SUPPORTED_ESCALATION_POLICIES = {"all_approve"}
    SUPPORTED_FINDINGS_COMBINATIONS = {"merge_across_tiers"}
    SUPPORTED_WITHIN_TIER_AGGREGATIONS = {"strict_consensus"}

    @classmethod
    def from_file(
        cls,
        path: str | Path,
        override_path: str | Path | None = None,
    ) -> CascadeConfig:
        """Load the base config, then additively merge an optional override.

        *override_path* (canonical location:
        ``.opencode/repo-configs/review-tiers.json``) is the operator-owned
        project roster lever. When the file exists its keys are deep-merged
        over the base: nested dicts merge recursively with the override
        winning; lists (``tiers``) and scalars are replaced wholesale. When
        it does not exist the base config is used unchanged.
        """
        with open(path) as f:
            data = json.load(f)
        if override_path is not None and Path(override_path).is_file():
            with open(override_path) as f:
                override = json.load(f)
            data = _deep_merge(data, override)
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict) -> CascadeConfig:
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

        # Parse the optional schema_version 2 panel section — roster-relevant
        # keys only (roles, lenses, leaf_roles). class_ownership and quorum
        # stay UNPARSED routing documentation (see module docstring).
        panel: Optional[PanelConfig] = None
        panel_data = data.get("panel")
        if panel_data is not None:
            if not isinstance(panel_data, dict):
                raise ValueError(
                    f"Config field 'panel' must be an object, "
                    f"got {type(panel_data).__name__}"
                )
            panel = _parse_panel(panel_data)

        return cls(
            schema_version=schema_version,
            tiers=tiers,
            fail_fast=fail_fast,
            escalation_policy=escalation_policy,
            findings_combination=findings_combination,
            lightweight_review=lightweight_review,
            panel=panel,
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


def _deep_merge(base: dict, override: dict) -> dict:
    """Additively merge *override* over *base* (override wins).

    Nested dicts merge recursively; every other value type — notably lists
    such as ``tiers`` — is replaced wholesale. Returns a new dict; inputs are
    not mutated.
    """
    out = dict(base)
    for key, value in override.items():
        if (
            key in out
            and isinstance(out[key], dict)
            and isinstance(value, dict)
        ):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _parse_panel(panel_data: dict) -> PanelConfig:
    """Parse the roster-relevant subset of the ``panel`` section.

    Structural validation happens here (types, complete role/lens entries);
    roster-level composition validation (N>=2 generalists, total<=5, known
    leaf IDs) happens in :func:`validate_roster`.
    """
    roles = panel_data.get("roles", {})
    lenses = panel_data.get("lenses", {})
    leaf_roles_raw = panel_data.get("leaf_roles", {})
    if not isinstance(roles, dict):
        raise ValueError("panel.roles must be an object")
    if not isinstance(lenses, dict):
        raise ValueError("panel.lenses must be an object")
    if not isinstance(leaf_roles_raw, dict):
        raise ValueError("panel.leaf_roles must be an object")

    leaf_roles: dict[str, LeafRole] = {}
    for leaf, entry in leaf_roles_raw.items():
        if leaf.startswith("_"):
            continue  # _comment keys are documentation, not leaf entries
        if not isinstance(entry, dict):
            raise ValueError(
                f"panel.leaf_roles[{leaf!r}] must be an object with 'role' and 'lens', "
                f"got {type(entry).__name__}"
            )
        role = entry.get("role")
        lens = entry.get("lens")
        if not role or not lens:
            raise ValueError(
                f"panel.leaf_roles[{leaf!r}] is incomplete: both 'role' and 'lens' are "
                f"required on any present entry (omit the entry entirely for the "
                f"generalist default, but never a half entry) — got role={role!r}, lens={lens!r}"
            )
        if leaf not in REGISTERED_LEAVES:
            raise ValueError(
                f"panel.leaf_roles names unknown leaf {leaf!r}; registered pool is "
                f"{list(REGISTERED_LEAVES)}"
            )
        if role not in roles:
            raise ValueError(
                f"panel.leaf_roles[{leaf!r}].role {role!r} is not defined in panel.roles"
            )
        if lens not in lenses:
            raise ValueError(
                f"panel.leaf_roles[{leaf!r}].lens {lens!r} is not defined in panel.lenses"
            )
        leaf_roles[leaf] = LeafRole(role=role, lens=lens)

    return PanelConfig(roles=roles, lenses=lenses, leaf_roles=leaf_roles)


def active_leaves(config: CascadeConfig) -> list[str]:
    """Ordered list of ACTIVE leaf names (leaves of non-disabled, non-empty tiers)."""
    out: list[str] = []
    for tier in config.tiers:
        if not tier.disabled:
            out.extend(tier.leaves)
    return out


def roster_composition(config: CascadeConfig) -> tuple[list[str], list[str]]:
    """Split the active roster into (generalists, specialists) by panel role.

    A leaf with no panel.leaf_roles entry defaults to generalist
    (r1_redundant) — the documented graceful fallback.
    """
    generalists: list[str] = []
    specialists: list[str] = []
    for leaf in active_leaves(config):
        if config.panel is not None and config.panel.is_generalist(leaf):
            generalists.append(leaf)
        elif config.panel is None:
            generalists.append(leaf)
        else:
            specialists.append(leaf)
    return generalists, specialists


def validate_roster(config: CascadeConfig) -> list[str]:
    """Validate roster composition BEFORE any dispatch.

    V1 PRESERVATION (backward-compatibility contract, pinned by
    V1DispatchPreservationTest): when the merged config carries NO ``panel``
    section (a schema_version 1 or panel-less config), the bounded-B roster
    rules below DO NOT apply — this function raises nothing and returns no
    warnings, so a pre-panel roster (custom leaf IDs outside the a..e pool,
    single-leaf tiers, any tier shape) parses AND dispatches exactly as it
    did before the bounded-B slice. Every rule fires only when a panel IS
    declared (schema_version 2 — the shipped config and any override built
    on it keep unchanged strictness).

    Raises ValueError on any hard violation (panel configs only):
      - a leaf ID appearing in more than one tier (or twice in one tier);
      - a leaf ID outside the registered 5-seat pool;
      - fewer than MIN_GENERALISTS (=2) active generalist seats;
      - more than MAX_ACTIVE_LEAVES (=5) active leaves total.

    Structural panel checks (incomplete role/lens entries, unknown
    roles/lenses/leaves in leaf_roles) are enforced at parse time in
    _parse_panel, which from_file/from_dict always run when a panel section
    is present — so they also reject before dispatch. (Parse-time tier
    checks — non-empty leaves, valid aggregation, at least one active tier —
    apply to v1 configs too, exactly as they always have.)

    Returns a list of non-blocking prerequisite WARNINGS the caller must
    surface (never silently drop). Today the only warning is the
    specialist-floor fixture prerequisite (per-class quorum merge-layer
    fixtures) for M>=2 specialist rosters.
    """
    if config.panel is None:
        # Panel-less (v1) config: bounded-B roster rules do not apply. The
        # model preflight (preflight_models) is deliberately NOT gated here —
        # it enforces the per-leaf model-file convention that predates the
        # panel capacity and holds for every schema version.
        return []

    warnings: list[str] = []

    seen: set[str] = set()
    for tier in config.tiers:
        for leaf in tier.leaves:
            if leaf in seen:
                raise ValueError(
                    f"leaf {leaf!r} appears more than once across tiers — each seat "
                    f"may serve on at most one tier"
                )
            seen.add(leaf)
            if leaf not in REGISTERED_LEAVES:
                raise ValueError(
                    f"tier {tier.name!r} names unknown leaf {leaf!r}; registered pool "
                    f"is {list(REGISTERED_LEAVES)}"
                )

    active = active_leaves(config)
    if len(active) > MAX_ACTIVE_LEAVES:
        raise ValueError(
            f"active roster has {len(active)} leaves; bounded-B capacity is at most "
            f"{MAX_ACTIVE_LEAVES} (registered pool {list(REGISTERED_LEAVES)})"
        )

    generalists, specialists = roster_composition(config)
    if len(generalists) < MIN_GENERALISTS:
        raise ValueError(
            f"active roster has only {len(generalists)} generalist seat(s) "
            f"({generalists}); at least {MIN_GENERALISTS} independently-attributable "
            f"generalists are required so every finding class keeps redundant coverage"
        )

    if len(specialists) >= 2:
        warnings.append(
            SPECIALIST_FLOOR_PREREQUISITE.format(
                n=len(specialists), leaves=", ".join(specialists)
            )
        )

    return warnings


def preflight_models(
    config: CascadeConfig,
    repo_root: str | Path = ".",
) -> None:
    """Hard-refuse dispatch when any ACTIVE leaf has no usable model file.

    For every leaf on an active tier, ``<repo_root>/.local/config/agent-model/
    <leaf>`` must exist and be non-empty. Model identity is operator-local
    (gitignored, never in templates), so this is a RUNTIME dispatch check —
    the orchestrator runs it BEFORE invoking any leaf (lightweight Step 0 or
    tier cascade alike), and :func:`run_cascade` enforces the same refusal
    MECHANICALLY on its own dispatch path (pre-dispatch, before any leaf is
    consulted). Raises ModelPreflightError naming every offending seat;
    returns None when the roster is dispatchable.
    """
    model_dir = Path(repo_root) / ".local" / "config" / "agent-model"
    problems: list[str] = []
    for leaf in active_leaves(config):
        model_file = model_dir / leaf
        if not model_file.is_file():
            problems.append(f"{leaf}: model file missing ({model_file})")
        elif model_file.stat().st_size == 0:
            problems.append(f"{leaf}: model file is zero bytes ({model_file})")
    if problems:
        raise ModelPreflightError(
            "review roster preflight FAILED — refusing to dispatch; seed the model "
            "file(s) under .local/config/agent-model/ before activating these "
            "seat(s): " + "; ".join(problems)
        )


def select_lightweight_leaf(config: CascadeConfig) -> str:
    """Select the lightweight single-leaf seat for ``leaf_selector: first``.

    Deliberate bounded-B behavior: "first" means the first ACTIVE GENERALIST
    in config leaf order — NOT the first leaf outright. The first configured
    leaf is frequently a specialist seat (e.g. commit-reviewer-a holds
    r2_contract_data under Lever E), and the lightweight path wants the
    broad-coverage generalist, not a focused lens. Falls back to the first
    active leaf only if no generalist exists (defensive — validate_roster
    already rejects rosters with fewer than two generalists).
    """
    active = active_leaves(config)
    if not active:
        raise ValueError("no active leaves — cannot select a lightweight seat")
    if config.panel is not None:
        for leaf in active:
            if config.panel.is_generalist(leaf):
                return leaf
    return active[0]


# Domain-free steering directives for the seat_routing payload — generic
# role/lens vocabulary only, mirroring the orchestrator prompt's specialist /
# generalist branches (which use the SAME GENERALIST_ROLES predicate).
_SPECIALIST_DIRECTIVE = (
    "specialist seat — prioritize the capability-bound review concerns in "
    "generic terms (declared-contract consistency, state-transition "
    "correctness, data invariants, subtle concurrency correctness) while "
    "still reviewing every finding class across the diff; the focus is an "
    "emphasis, NOT a narrowing of scope"
)
_GENERALIST_DIRECTIVE = (
    "independently-attributable redundant generalist — covers all finding "
    "classes with no special emphasis"
)


def seat_routing(config: CascadeConfig, leaf: str) -> Optional[dict]:
    """Compute the per-seat routing metadata payload for *leaf*.

    This is the reference implementation of the orchestrator's
    ``seat_routing`` block (attention steering ONLY — it changes NO
    disposition, evidence, aggregation, or quorum rule). It MUST be
    computed from the MERGED configuration (base + operator override, i.e.
    whatever ``CascadeConfig.from_file`` returned) so that an override
    changing a leaf's ``role``/``lens`` reaches the leaf's routing payload
    — reading only the base file would silently drop override changes.

    The generalist/specialist branch uses :data:`GENERALIST_ROLES` (both
    ``r1_redundant`` and ``r1_backup_secondary`` are generalists), the same
    predicate the lightweight seat selector uses.

    Returns None when the panel section is absent or the leaf has no
    ``panel.leaf_roles`` entry — the graceful generalist fallback forwards
    ``seat_routing: null``. The payload is DOMAIN-FREE by contract: generic
    role/lens IDs and generic review terms only.
    """
    if config.panel is None:
        return None
    entry = config.panel.leaf_roles.get(leaf)
    if entry is None:
        return None
    lens_meta = config.panel.lenses.get(entry.lens, {})
    role_meta = config.panel.roles.get(entry.role, {})
    generalist = config.panel.is_generalist(leaf)
    return {
        "leaf": leaf,
        "role": entry.role,
        "lens": entry.lens,
        "generalist": generalist,
        "finding_classes": list(lens_meta.get("finding_classes", [])),
        "role_description": role_meta.get("description", ""),
        "directive": _GENERALIST_DIRECTIVE if generalist else _SPECIALIST_DIRECTIVE,
    }


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
    repo_root: str | Path = ".",
) -> CascadeResult:
    """
    Run the tiered cascade state machine.

    leaf_simulator maps leaf names (e.g. "commit-reviewer-b") to their
    simulated results. Missing leaves are treated as failed.

    changed_files is optional. If provided and all files match the
    lightweight_review doc_globs, the cascade is replaced by a single-leaf
    result with lightweight=True.

    repo_root locates the operator-local model files for the MECHANICAL
    pre-dispatch preflight (see :func:`preflight_models`) — the same check
    the orchestrator prompt mandates. The refusal does not depend on
    orchestrator prompt conformance: run_cascade itself hard-refuses
    (ModelPreflightError) before ANY leaf — lightweight or tier — is
    consulted, whenever an ACTIVE leaf's model file is missing or zero
    bytes. Inactive (disabled-tier) seats are exempt.
    """
    # Step -1: ROSTER VALIDATION — hard-reject before ANY dispatch path
    # (duplicate/unknown seat IDs, <2 generalists, >5 active leaves; the
    # structural panel checks already ran at parse time). V1 preservation:
    # validate_roster is a NO-OP for panel-less (schema_version 1) configs,
    # which dispatch exactly as they did before the bounded-B slice — the
    # bounded-B rules fire only when a panel section is declared. Warnings
    # returned here (e.g. the specialist-floor fixture prerequisite for
    # M>=2 specialist rosters) are surfaced in validation_notes on every
    # result — a documented gate, never a silent pass.
    roster_warnings = validate_roster(config)

    # Step -0.5: MODEL PREFLIGHT — mechanical hard refusal before ANY leaf
    # (lightweight Step 0 included) is consulted, for any ACTIVE leaf whose
    # model file is missing or zero bytes. Registered-but-inactive seats are
    # exempt (active_leaves only walks non-disabled tiers).
    preflight_models(config, repo_root=repo_root)

    def _with_roster_notes(notes: str) -> str:
        if not roster_warnings:
            return notes
        prefix = "\n".join(f"[roster] {w}" for w in roster_warnings)
        return f"{prefix}\n{notes}" if notes else prefix

    # Step 0: Lightweight review check
    if changed_files is not None and config.should_use_lightweight_review(changed_files):
        # Bounded-B seat selection: leaf_selector "first" selects the first
        # ACTIVE GENERALIST (broad block_finder coverage), NOT the first
        # configured leaf — the first seat is frequently a specialist under
        # Lever E (commit-reviewer-a holds r2_contract_data).
        leaf_name = select_lightweight_leaf(config)
        tier = next(
            (t for t in config.tiers if not t.disabled and leaf_name in t.leaves),
            None,
        )
        if tier is not None:
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
                validation_notes=_with_roster_notes(lr.validation_notes or "Lightweight single-leaf review"),
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
            # Hardened seat-letter extraction: split on the final hyphen so
            # any registered leaf id (commit-reviewer-a .. -e, and any future
            # -f/-g style id) keys correctly. The old leaf_name[-1] form
            # happened to work for single-letter suffixes but is fragile by
            # accident rather than by construction.
            leaf_letter = leaf_name.split("-")[-1]  # e.g. "commit-reviewer-b" -> "b"
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
                    validation_notes=_with_roster_notes("\n".join(combined_notes)),
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
                    validation_notes=_with_roster_notes("\n".join(combined_notes)),
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
        validation_notes=_with_roster_notes("\n".join(combined_notes)),
        tiers_executed=tiers_executed,
        tiers_skipped=tiers_skipped,
        leaf_results=all_leaf_results,
        findings=combined_findings,
        deferred_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DEFER.value],
        dropped_findings=[f.get("id", "?") for f in combined_findings if f.get("disposition") == Disposition.DROP.value],
        resolved_categories=resolved_categories,
    )
