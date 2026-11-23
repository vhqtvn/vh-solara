"""Regression + acceptance suite for the shipped review-tiers.json against the
Python cascade loader (``CascadeConfig.from_file`` / ``from_dict``) and the
bounded-B roster machinery in ``tier_cascade.py``.

History: the original defer-018 parse-baseline pinned that the schema-v2
``panel`` block was ACCEPTED-but-IGNORED (no panel-derived field on
CascadeConfig). The bounded-B 5-seat slice upgraded that contract CONSCIOUSLY
— exactly the reactivation condition the old pin documented: the loader now
parses ``panel.roles`` / ``panel.lenses`` / ``panel.leaf_roles`` for ROSTER
VALIDATION and LIGHTWEIGHT SEAT SELECTION. ``panel.class_ownership`` and
``panel.quorum`` remain UNCONSUMED by this module (aggregation semantics are
unchanged), which keeps the per-class-quorum consumption upgrade condition
unfired; the specialist-floor condition (a second leaf taking a specialist
role) is now machine-surfaced as the DOMAIN-FREE fixture-prerequisite warning
at M>=2. Shipped core surfaces never name an adopting project's backlog IDs —
the warning text itself pins that contract below by asserting the exact
generic wording.

Stdlib-only (no pytest): this repo has no Python test convention, so the file
is a standalone runnable module.

Run::

    python3 .opencode/sys-scripts/tier_cascade_test.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

# Make the sibling tier_cascade.py importable regardless of CWD. Both the
# template source (templates/core/.opencode/sys-scripts/) and the rendered
# copy (.opencode/sys-scripts/) keep tier_cascade.py as a sibling.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import tier_cascade  # noqa: E402  (sys.path set up above)
from tier_cascade import (  # noqa: E402
    SPECIALIST_FLOOR_PREREQUISITE,
    CascadeConfig,
    Confidence,
    LeafResult,
    ModelPreflightError,
    Risk,
    Verdict,
    preflight_models,
    run_cascade,
    seat_routing,
    select_lightweight_leaf,
    validate_roster,
)

# The REAL shipped config lives at <root>/.opencode/config/review-tiers.json.
# From <root>/.opencode/sys-scripts/ that is ../config/review-tiers.json.
CONFIG_PATH = _HERE.parent / "config" / "review-tiers.json"

# Lever E panel: the active "free" tier carries a fixed 4-leaf count, with
# commit-reviewer-a as the contract/data-integrity specialist seat and
# b/c/d as independently-attributable redundant generalists (3+1 default).
_EXPECTED_FREE_LEAVES = [
    "commit-reviewer-a",
    "commit-reviewer-b",
    "commit-reviewer-c",
    "commit-reviewer-d",
]

_ALL_LEAVES = [f"commit-reviewer-{s}" for s in "abcde"]


def _shaped_config(
    leaves: list[str],
    leaf_roles: dict | None = None,
    disabled_leaves: list[str] | None = None,
) -> dict:
    """A shipped-shaped schema-v2 config dict for tests.

    Roles/lenses mirror the shipped panel; *leaf_roles* defaults to the
    Lever-E shape (a specialist, everyone else generalist) over *leaves*.
    The disabled "premium" tier is included ONLY when *disabled_leaves* is
    given (the loader rejects tiers with empty leaves lists).
    """
    roles = {
        leaf: {"role": "r1_redundant", "lens": "block_finder"}
        for leaf in leaves
    }
    if leaf_roles is not None:
        roles = dict(roles, **leaf_roles)
    tiers = [
        {"name": "free", "leaves": leaves, "within_tier_aggregation": "strict_consensus"},
    ]
    if disabled_leaves is not None:
        tiers.append({
            "name": "premium",
            "leaves": disabled_leaves,
            "within_tier_aggregation": "strict_consensus",
            "disabled": True,
        })
    return {
        "schema_version": 2,
        "tiers": tiers,
        "fail_fast": True,
        "escalation_policy": "all_approve",
        "findings_combination": "merge_across_tiers",
        "panel": {
            "roles": {
                "r1_redundant": {"description": "redundant generalist"},
                "r1_backup_secondary": {"description": "backup generalist"},
                "r2_contract_data": {"description": "contract/data specialist"},
                "r3_security": {"description": "security specialist"},
            },
            "lenses": {
                "block_finder": {"description": "generalist", "finding_classes": ["*"]},
                "contract_data": {"description": "contract/data", "finding_classes": ["contract_drift", "data_integrity"]},
                "security": {"description": "security", "finding_classes": ["security"]},
            },
            "leaf_roles": roles,
        },
        "lightweight_review": {
            "doc_globs": ["docs/**/*.md", "docs/*.md"],
            "mode": "single_leaf",
            "leaf_selector": "first",
        },
    }


def _leaf_result(
    leaf: str,
    verdict: Verdict = Verdict.APPROVE,
    findings: list[dict] | None = None,
) -> LeafResult:
    return LeafResult(
        leaf_key=leaf,
        verdict=verdict,
        confidence=Confidence.HIGH,
        risk=Risk.LOW,
        findings=findings or [],
        reviewed_files=[],
        validation_notes="",
    )


def _seed_models(
    tmpdir: Path,
    leaves: list[str],
    empty: list[str] | None = None,
) -> Path:
    """Seed operator-style model files under *tmpdir*; returns the repo root.

    Every leaf in *leaves* gets ``.local/config/agent-model/<leaf>``; leaves
    listed in *empty* get a ZERO-BYTE file (still present, unusable). Keeps
    the suite self-contained — run_cascade's mechanical preflight never
    depends on the adopting repo's real .local state.
    """
    d = tmpdir / ".local" / "config" / "agent-model"
    d.mkdir(parents=True, exist_ok=True)
    for leaf in leaves:
        (d / leaf).write_text("" if leaf in (empty or []) else "stub-model\n")
    return tmpdir


class _TrackingSimulator(dict):
    """A leaf_simulator that records whether ANY leaf was consulted.

    run_cascade consults the simulator via ``in`` / ``[]`` — overriding both
    lets the preflight-wiring tests assert the refusal fired BEFORE any
    simulated leaf executed.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.accessed = False

    def __contains__(self, key):
        self.accessed = True
        return super().__contains__(key)

    def __getitem__(self, key):
        self.accessed = True
        return super().__getitem__(key)


_EVIDENCED_BLOCK = {
    "id": "F1",
    "axis": "standards",
    "severity": "critical",
    "category": "security",
    "disposition": "block",
    "location": "app.py:L7",
    "issue": "Auth bypass",
    "suggestion": "Add role check",
    "evidence": {
        "type": "security_path",
        "reference": "app.py:L7",
        "description": "Any authenticated user can delete any resource.",
    },
}


class ShippedConfigParseTest(unittest.TestCase):
    """The real, committed review-tiers.json must load through the real loader."""

    def setUp(self):
        self.assertTrue(
            CONFIG_PATH.exists(),
            f"missing shipped config: {CONFIG_PATH}",
        )
        with open(CONFIG_PATH) as f:
            self.raw = json.load(f)

    def test_loads_cleanly(self):
        # THE load-bearing crux: the shipped config parses with no exception.
        cfg = CascadeConfig.from_file(CONFIG_PATH)
        self.assertIsNotNone(cfg)

    def test_schema_version_supported_and_declared_v2(self):
        # SUPPORTED_SCHEMA_VERSIONS must include both 1 and 2 (v2 = panel capacity).
        self.assertEqual(CascadeConfig.SUPPORTED_SCHEMA_VERSIONS, {1, 2})
        # The shipped config declares schema_version 2.
        self.assertEqual(self.raw.get("schema_version"), 2)
        cfg = CascadeConfig.from_file(CONFIG_PATH)
        self.assertEqual(cfg.schema_version, 2)

    def test_free_tier_seats_resolve(self):
        # Representative field: the active "free" tier resolves with the
        # 4-leaf Lever-E panel (specialist seat + three redundant generalists).
        cfg = CascadeConfig.from_file(CONFIG_PATH)
        free = next((t for t in cfg.tiers if t.name == "free"), None)
        self.assertIsNotNone(free, "shipped config must define a 'free' tier")
        self.assertFalse(free.disabled, "'free' tier must be active")
        self.assertEqual(free.leaves, _EXPECTED_FREE_LEAVES)
        self.assertIn("commit-reviewer-a", free.leaves)

    def test_lightweight_review_resolves(self):
        # Representative field: lightweight_review doc_globs are non-empty and
        # the mode parses.
        cfg = CascadeConfig.from_file(CONFIG_PATH)
        self.assertIsNotNone(cfg.lightweight_review)
        self.assertTrue(cfg.lightweight_review.doc_globs)
        self.assertEqual(cfg.lightweight_review.mode, "single_leaf")

    def test_panel_parsed_roster_fields_only(self):
        # CONTRACT PIN (upgraded consciously by the bounded-B slice — the
        # original defer-018 pin required the panel to stay inert, and its
        # docstring named this exact upgrade path): the loader now PARSES the
        # roster-relevant panel keys. CascadeConfig exposes a panel whose
        # leaf_roles resolve the Lever-E shape (a = specialist, b/c/d =
        # generalists) plus the registered-but-inactive seat e's generalist
        # DEFAULT entry. class_ownership/quorum stay UNPARSED — pinned below
        # so aggregation semantics cannot drift without this test failing.
        cfg = CascadeConfig.from_file(CONFIG_PATH)
        self.assertIsNotNone(cfg.panel)
        self.assertFalse(cfg.panel.is_generalist("commit-reviewer-a"))
        for leaf in ("commit-reviewer-b", "commit-reviewer-c", "commit-reviewer-d"):
            self.assertTrue(cfg.panel.is_generalist(leaf))
        # Seat e: registered with a generalist default entry; INACTIVE in the
        # shipped tiers (premium disabled) — registered != active.
        self.assertTrue(cfg.panel.is_generalist("commit-reviewer-e"))
        self.assertNotIn("commit-reviewer-e", cfg.tiers[0].leaves)
        # Boundary pin: no class_ownership / quorum fields — the
        # per-class-quorum consumption upgrade condition stays unfired
        # (aggregation semantics cannot drift without this test failing).
        self.assertFalse(hasattr(cfg.panel, "class_ownership"))
        self.assertFalse(hasattr(cfg.panel, "quorum"))


class ShippedRosterValidationTest(unittest.TestCase):
    """The shipped 3+1 default roster validates clean under the new validators."""

    def test_shipped_default_validates_clean(self):
        cfg = CascadeConfig.from_file(CONFIG_PATH)
        warnings = validate_roster(cfg)  # must not raise
        self.assertEqual(warnings, [], "shipped 3+1 default must produce no warnings")


class RosterValidatorTest(unittest.TestCase):
    """Hard rejections fire BEFORE dispatch; warnings surface, never silently pass."""

    def _cfg(self, **kwargs) -> CascadeConfig:
        return CascadeConfig.from_dict(_shaped_config(**kwargs))

    def test_two_generalists_zero_specialists_valid(self):
        # 2+0 minimal roster validates clean.
        cfg = self._cfg(leaves=["commit-reviewer-b", "commit-reviewer-c"])
        warnings = validate_roster(cfg)
        self.assertEqual(warnings, [])

    def test_duplicate_leaf_id_rejects(self):
        dup = _shaped_config(leaves=["commit-reviewer-b", "commit-reviewer-c"])
        dup["tiers"].append({"name": "free2", "leaves": ["commit-reviewer-b", "commit-reviewer-d"]})
        with self.assertRaisesRegex(ValueError, "more than once"):
            validate_roster(CascadeConfig.from_dict(dup))

    def test_unknown_leaf_id_rejects(self):
        bad = _shaped_config(leaves=["commit-reviewer-b", "commit-reviewer-z"])
        bad["panel"]["leaf_roles"].pop("commit-reviewer-z")
        with self.assertRaisesRegex(ValueError, "unknown leaf"):
            validate_roster(CascadeConfig.from_dict(bad))

    def test_fewer_than_two_generalists_rejects(self):
        # One specialist + one generalist = 1 generalist -> hard reject.
        cfg = self._cfg(
            leaves=["commit-reviewer-a", "commit-reviewer-b"],
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        )
        with self.assertRaisesRegex(ValueError, "at least 2"):
            validate_roster(cfg)

    def test_over_five_active_leaves_rejects(self):
        # The cap is unreachable through the real 5-seat registered pool
        # (unique+known IDs cap active at 5), so prove the cap logic itself
        # by extending the pool with a hypothetical 6th seat.
        original = tier_cascade.REGISTERED_LEAVES
        try:
            tier_cascade.REGISTERED_LEAVES = original + ("commit-reviewer-f",)
            data = _shaped_config(
                leaves=[
                    "commit-reviewer-a", "commit-reviewer-b", "commit-reviewer-c",
                    "commit-reviewer-d", "commit-reviewer-e", "commit-reviewer-f",
                ],
                leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
            )
            cfg = CascadeConfig.from_dict(data)
            with self.assertRaisesRegex(ValueError, "at most 5"):
                validate_roster(cfg)
        finally:
            tier_cascade.REGISTERED_LEAVES = original

    def test_incomplete_leaf_roles_entry_rejects(self):
        bad = _shaped_config(leaves=["commit-reviewer-b", "commit-reviewer-c"])
        bad["panel"]["leaf_roles"]["commit-reviewer-b"] = {"role": "r1_redundant"}  # lens missing
        with self.assertRaisesRegex(ValueError, "incomplete"):
            CascadeConfig.from_dict(bad)

    def test_unknown_role_rejects(self):
        bad = _shaped_config(leaves=["commit-reviewer-b", "commit-reviewer-c"])
        bad["panel"]["leaf_roles"]["commit-reviewer-b"] = {"role": "r9_nonexistent", "lens": "block_finder"}
        with self.assertRaisesRegex(ValueError, "not defined in panel.roles"):
            CascadeConfig.from_dict(bad)

    def test_unknown_lens_rejects(self):
        bad = _shaped_config(leaves=["commit-reviewer-b", "commit-reviewer-c"])
        bad["panel"]["leaf_roles"]["commit-reviewer-b"] = {"role": "r1_redundant", "lens": "no_such_lens"}
        with self.assertRaisesRegex(ValueError, "not defined in panel.lenses"):
            CascadeConfig.from_dict(bad)

    def test_leaf_roles_entry_for_unregistered_leaf_rejects(self):
        bad = _shaped_config(leaves=["commit-reviewer-b", "commit-reviewer-c"])
        bad["panel"]["leaf_roles"]["commit-reviewer-z"] = {"role": "r1_redundant", "lens": "block_finder"}
        with self.assertRaisesRegex(ValueError, "unknown leaf"):
            CascadeConfig.from_dict(bad)

    def test_run_cascade_rejects_invalid_roster_before_dispatch(self):
        # The gate is pre-dispatch: an invalid roster raises before ANY leaf
        # would be invoked (even when a full simulator is supplied).
        cfg = self._cfg(
            leaves=["commit-reviewer-a", "commit-reviewer-b"],
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        )
        simulator = {leaf: _leaf_result(leaf) for leaf in ("commit-reviewer-a", "commit-reviewer-b")}
        with self.assertRaises(ValueError):
            run_cascade(cfg, simulator)

    def test_m_ge_2_specialists_surface_fixture_prerequisite(self):
        # M>=2 specialists: NOT a rejection — a documented gate. The warning
        # is the DOMAIN-FREE specialist-floor wording (no adopting-project
        # backlog IDs in shipped surfaces) and reaches the cascade result's
        # notes. The exact-equality pin means any re-introduction of a
        # project-specific literal into the shipped warning fails here.
        cfg = self._cfg(
            leaves=["commit-reviewer-a", "commit-reviewer-b", "commit-reviewer-c", "commit-reviewer-d"],
            leaf_roles={
                "commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"},
                "commit-reviewer-b": {"role": "r3_security", "lens": "security"},
            },
        )
        warnings = validate_roster(cfg)  # 2 generalists + 2 specialists: valid
        self.assertEqual(len(warnings), 1)
        self.assertEqual(
            warnings[0],
            SPECIALIST_FLOOR_PREREQUISITE.format(
                n=2, leaves="commit-reviewer-a, commit-reviewer-b"
            ),
        )
        simulator = {leaf: _leaf_result(leaf) for leaf in _EXPECTED_FREE_LEAVES}
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES)
            result = run_cascade(cfg, simulator, repo_root=root)
        self.assertIn("specialist-floor fixture prerequisite", result.validation_notes)
        self.assertIn("M>=2", result.validation_notes)


class V1DispatchPreservationTest(unittest.TestCase):
    """tier1_c/F1 regression (round 2): a panel-less config (schema_version 1,
    no ``panel`` section) must parse AND DISPATCH exactly as it did before the
    bounded-B slice. The bounded-B roster rules — registered-pool membership,
    the >=2 generalist floor, the 5-seat cap, duplicate-seat rejection — are
    gated on panel presence; an unconditional validate_roster inside
    run_cascade retrofitted them onto pre-panel rosters (custom leaf IDs,
    single-leaf tiers) that always dispatched. v2 strictness is unchanged
    (RosterValidatorTest above still pins every rejection)."""

    _CUSTOM_LEAF = "night-watch-reviewer"  # outside the registered a..e pool

    def _v1_config(self) -> dict:
        # Single-leaf tier + custom leaf ID: doubly invalid under bounded-B,
        # perfectly valid schema_version 1.
        return {
            "schema_version": 1,
            "tiers": [
                {
                    "name": "solo",
                    "leaves": [self._CUSTOM_LEAF],
                    "within_tier_aggregation": "strict_consensus",
                }
            ],
            "fail_fast": True,
            "escalation_policy": "all_approve",
            "findings_combination": "merge_across_tiers",
        }

    def test_v1_roster_validation_is_noop(self):
        # No raise, no warnings — including for roster shapes bounded-B
        # rejects (unknown leaf IDs, single-leaf rosters, duplicated seats).
        cfg = CascadeConfig.from_dict(self._v1_config())
        self.assertIsNone(cfg.panel)
        self.assertEqual(validate_roster(cfg), [])
        dup = self._v1_config()
        dup["tiers"].append({
            "name": "solo2",
            "leaves": [self._CUSTOM_LEAF],
            "within_tier_aggregation": "strict_consensus",
        })
        self.assertEqual(validate_roster(CascadeConfig.from_dict(dup)), [])

    def test_v1_custom_leaf_single_leaf_tier_dispatches(self):
        # THE dispatch-level crux: the no-panel roster actually DISPATCHES
        # and returns ATTRIBUTED results (verdict, per-leaf result key,
        # findings, deferred ids, reviewed files) — not merely a clean
        # parse. Today's pre-slice v1 rosters must keep dispatching.
        cfg = CascadeConfig.from_dict(self._v1_config())
        finding = {
            "id": "V1-1",
            "axis": "standards",
            "severity": "major",
            "category": "correctness",
            "disposition": "defer",
            "location": "legacy.py:L9",
            "issue": "pre-panel roster finding",
            "suggestion": "kept as advisory",
        }
        leaf = _leaf_result(self._CUSTOM_LEAF, Verdict.APPROVE, [finding])
        leaf.reviewed_files = ["legacy.py"]
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), [self._CUSTOM_LEAF])
            result = run_cascade(cfg, {self._CUSTOM_LEAF: leaf}, repo_root=root)
        self.assertEqual(result.verdict, Verdict.APPROVE)
        self.assertEqual(result.tiers_executed, ["solo"])
        self.assertFalse(result.lightweight)
        # Attribution: hardened seat-letter extraction keys the custom id.
        self.assertEqual(set(result.leaf_results), {"tier1_reviewer"})
        self.assertEqual(result.leaf_results["tier1_reviewer"]["verdict"], "approve")
        self.assertEqual(result.leaf_results["tier1_reviewer"]["deferred_count"], 1)
        self.assertEqual(result.reviewed_files, ["legacy.py"])
        self.assertEqual([f["id"] for f in result.findings], ["V1-1"])
        self.assertEqual(result.deferred_findings, ["V1-1"])

    def test_v1_model_preflight_still_applies(self):
        # Boundary pin: the MODEL preflight is NOT panel-gated — it enforces
        # the per-leaf .local/config/agent-model/<leaf> convention that
        # predates the bounded-B slice, so a v1 roster still refuses
        # dispatch when its (custom-named) active leaf has no model file.
        cfg = CascadeConfig.from_dict(self._v1_config())
        sim = _TrackingSimulator()
        sim[self._CUSTOM_LEAF] = _leaf_result(self._CUSTOM_LEAF)
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaisesRegex(ModelPreflightError, self._CUSTOM_LEAF):
                run_cascade(cfg, sim, repo_root=Path(raw))  # no models seeded
        self.assertFalse(
            sim.accessed, "preflight refusal must fire BEFORE any leaf is consulted"
        )


class FiveSeatAttributionTest(unittest.TestCase):
    """4+1: a five-seat active roster executes five attributable leaves with
    distinct result keys (tier1_a .. tier1_e) and no collisions. All five
    seats are ACTIVE here, so the mechanical model preflight requires all
    five model files seeded (the fixtures seed their own — self-contained)."""

    def _five_seat_cfg(self) -> CascadeConfig:
        # Operator-style 4+1: all five registered seats active, a keeps the
        # specialist role, e joins as a generalist (graceful default entry).
        return CascadeConfig.from_dict(_shaped_config(
            leaves=_ALL_LEAVES,
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        ))

    def _run_five_seat(self):
        cfg = self._five_seat_cfg()
        warnings = validate_roster(cfg)
        self.assertEqual(warnings, [])
        simulator = {leaf: _leaf_result(leaf) for leaf in _ALL_LEAVES}
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _ALL_LEAVES)
            return run_cascade(cfg, simulator, repo_root=root)

    def test_five_leaves_keyed_without_collision(self):
        result = self._run_five_seat()
        self.assertEqual(
            set(result.leaf_results.keys()),
            {"tier1_a", "tier1_b", "tier1_c", "tier1_d", "tier1_e"},
        )
        self.assertEqual(len(result.leaf_results), 5)

    def test_hardened_seat_letter_extraction(self):
        # The split("-")[-1] form keys multi-hyphen ids correctly; the old
        # leaf_name[-1] form would have keyed "leaf-seat-x" as "x" only by
        # accident and "x-y" wrongly as "y". Guard the extraction invariant.
        result = self._run_five_seat()
        # Every key carries the tier prefix and exactly one seat letter a..e.
        for key in result.leaf_results:
            self.assertRegex(key, r"^tier1_[a-e]$")


class ModelPreflightTest(unittest.TestCase):
    """Runtime dispatch preflight: an ACTIVE leaf without a usable model file
    hard-refuses BEFORE any leaf is invoked. Inactive (disabled-tier) seats
    are not preflighted. (The run_cascade-level wiring of the same refusal
    is covered separately in CascadePreflightWiringTest.)"""

    def _write_config(self, tmpdir: Path) -> Path:
        path = tmpdir / "review-tiers.json"
        path.write_text(json.dumps(_shaped_config(
            leaves=["commit-reviewer-a", "commit-reviewer-b"],
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
            disabled_leaves=["commit-reviewer-e"],
        )))
        return path

    def test_missing_model_file_refuses(self):
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            cfg = CascadeConfig.from_file(self._write_config(tmpdir))
            _seed_models(tmpdir, ["commit-reviewer-a"])  # b missing
            with self.assertRaisesRegex(ModelPreflightError, "commit-reviewer-b"):
                preflight_models(cfg, repo_root=tmpdir)

    def test_zero_byte_model_file_refuses(self):
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            cfg = CascadeConfig.from_file(self._write_config(tmpdir))
            _seed_models(tmpdir, ["commit-reviewer-a", "commit-reviewer-b"], empty=["commit-reviewer-b"])
            with self.assertRaisesRegex(ModelPreflightError, "zero bytes"):
                preflight_models(cfg, repo_root=tmpdir)

    def test_complete_roster_passes(self):
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            cfg = CascadeConfig.from_file(self._write_config(tmpdir))
            _seed_models(tmpdir, ["commit-reviewer-a", "commit-reviewer-b"])
            self.assertIsNone(preflight_models(cfg, repo_root=tmpdir))

    def test_inactive_seat_not_preflighted(self):
        # commit-reviewer-e sits in the DISABLED premium tier with no model
        # file — that must NOT refuse dispatch (registered != active).
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            cfg = CascadeConfig.from_file(self._write_config(tmpdir))
            _seed_models(tmpdir, ["commit-reviewer-a", "commit-reviewer-b"])
            # note: no model file for commit-reviewer-e
            self.assertIsNone(preflight_models(cfg, repo_root=tmpdir))


class CascadePreflightWiringTest(unittest.TestCase):
    """C-F4 wiring: run_cascade ITSELF enforces the model preflight
    mechanically on its dispatch path — the hard refusal does not depend on
    orchestrator prompt conformance. Any ACTIVE leaf with a missing or
    zero-byte model file refuses BEFORE any simulated leaf is consulted;
    inactive (disabled-tier) seats stay exempt."""

    def _cfg(self) -> CascadeConfig:
        return CascadeConfig.from_dict(_shaped_config(
            leaves=["commit-reviewer-a", "commit-reviewer-b", "commit-reviewer-c", "commit-reviewer-d"],
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
            disabled_leaves=["commit-reviewer-e"],
        ))

    def _simulator(self) -> _TrackingSimulator:
        sim = _TrackingSimulator()
        for leaf in _EXPECTED_FREE_LEAVES:
            sim[leaf] = _leaf_result(leaf)
        return sim

    def test_missing_model_file_refuses_before_any_leaf(self):
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES[:3])  # d missing
            sim = self._simulator()
            with self.assertRaisesRegex(ModelPreflightError, "commit-reviewer-d"):
                run_cascade(self._cfg(), sim, repo_root=root)
            self.assertFalse(
                sim.accessed, "refusal must fire BEFORE any simulated leaf is consulted"
            )

    def test_zero_byte_model_file_refuses_before_any_leaf(self):
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES, empty=["commit-reviewer-d"])
            sim = self._simulator()
            with self.assertRaisesRegex(ModelPreflightError, "zero bytes"):
                run_cascade(self._cfg(), sim, repo_root=root)
            self.assertFalse(
                sim.accessed, "refusal must fire BEFORE any simulated leaf is consulted"
            )

    def test_lightweight_path_refuses_before_leaf(self):
        # The preflight also guards the LIGHTWEIGHT Step 0 path: doc-glob
        # changed files + an unseeded active seat refuses before the
        # single lightweight leaf is consulted.
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES[:3])  # d missing
            sim = self._simulator()
            with self.assertRaisesRegex(ModelPreflightError, "commit-reviewer-d"):
                run_cascade(self._cfg(), sim, changed_files=["docs/notes.md"], repo_root=root)
            self.assertFalse(
                sim.accessed, "lightweight refusal must fire BEFORE the leaf is consulted"
            )

    def test_inactive_seat_exempt_in_run_cascade(self):
        # Seat e is registered-but-inactive (disabled premium tier) with NO
        # model file — dispatch proceeds. Registered != active at the wired
        # level too.
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES)  # e deliberately unseeded
            sim = self._simulator()
            result = run_cascade(self._cfg(), sim, repo_root=root)
            self.assertTrue(sim.accessed)
            self.assertEqual(result.verdict, Verdict.APPROVE)

    def test_seeded_roster_dispatches(self):
        # Wiring must not OVER-refuse: a fully seeded active roster
        # dispatches normally through the tier cascade.
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES)
            sim = self._simulator()
            result = run_cascade(self._cfg(), sim, repo_root=root)
            self.assertTrue(sim.accessed)
            self.assertEqual(result.verdict, Verdict.APPROVE)
            self.assertEqual(
                set(result.leaf_results.keys()),
                {"tier1_a", "tier1_b", "tier1_c", "tier1_d"},
            )


class LightweightGeneralistSelectionTest(unittest.TestCase):
    """leaf_selector "first" selects the first ACTIVE GENERALIST, not the
    specialist that happens to be the first configured leaf."""

    def _lever_e_cfg(self) -> CascadeConfig:
        return CascadeConfig.from_dict(_shaped_config(
            leaves=_EXPECTED_FREE_LEAVES,
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        ))

    def test_selects_first_generalist(self):
        cfg = self._lever_e_cfg()
        self.assertEqual(select_lightweight_leaf(cfg), "commit-reviewer-b")

    def test_lightweight_run_uses_generalist(self):
        cfg = self._lever_e_cfg()
        # Discriminating simulator: the specialist a would BLOCK; the
        # generalist b approves. If selection regressed to leaf[0] the
        # verdict would flip to blocked.
        simulator = {
            "commit-reviewer-a": _leaf_result("commit-reviewer-a", Verdict.BLOCKED, [dict(_EVIDENCED_BLOCK)]),
            "commit-reviewer-b": _leaf_result("commit-reviewer-b"),
            "commit-reviewer-c": _leaf_result("commit-reviewer-c"),
            "commit-reviewer-d": _leaf_result("commit-reviewer-d"),
        }
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES)
            result = run_cascade(cfg, simulator, changed_files=["docs/notes.md"], repo_root=root)
        self.assertTrue(result.lightweight)
        self.assertEqual(result.verdict, Verdict.APPROVE)
        self.assertIn("lightweight", result.leaf_results)


class SpecialistAuthorityInvariantTest(unittest.TestCase):
    """Attention steering is NOT authority: an off-focus specialist BLOCK with
    verifiable evidence still upholds `blocked` even though the finding class
    is outside the seat's declared lens."""

    def test_off_focus_specialist_block_upholds(self):
        # Seat a holds the contract_data lens, but raises a SECURITY block
        # (off-focus) with complete evidence while b/c/d stay silent. The
        # evidence-verifiability rule — not seat focus — decides the uphold.
        cfg = CascadeConfig.from_dict(_shaped_config(
            leaves=_EXPECTED_FREE_LEAVES,
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        ))
        simulator = {
            "commit-reviewer-a": _leaf_result("commit-reviewer-a", Verdict.BLOCKED, [dict(_EVIDENCED_BLOCK)]),
            "commit-reviewer-b": _leaf_result("commit-reviewer-b"),
            "commit-reviewer-c": _leaf_result("commit-reviewer-c"),
            "commit-reviewer-d": _leaf_result("commit-reviewer-d"),
        }
        with tempfile.TemporaryDirectory() as raw:
            root = _seed_models(Path(raw), _EXPECTED_FREE_LEAVES)
            result = run_cascade(cfg, simulator, repo_root=root)
        self.assertEqual(result.verdict, Verdict.BLOCKED)
        self.assertTrue(
            any(f.get("disposition") == "block" for f in result.findings),
            "the evidenced off-focus BLOCK must survive disagreement resolution",
        )


class SeatRoutingTest(unittest.TestCase):
    """C-F2/C-F3: the seat_routing payload is computed from the MERGED
    configuration (base + operator override) and branches on the SAME
    GENERALIST_ROLES predicate the reference implementation uses for seat
    selection (r1_redundant AND r1_backup_secondary are generalists)."""

    def test_override_role_change_reaches_seat_routing(self):
        # C-F2 regression: an override that changes a leaf's role/lens MUST
        # be reflected in the seat_routing payload computed from the merged
        # config — reading only the base file would silently drop it.
        base = _shaped_config(
            leaves=_EXPECTED_FREE_LEAVES,
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        )
        override = {
            "panel": {
                "leaf_roles": {
                    "commit-reviewer-a": {"role": "r3_security", "lens": "security"},
                },
            },
        }
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            base_path = tmpdir / "review-tiers.json"
            base_path.write_text(json.dumps(base))
            override_path = tmpdir / "override-review-tiers.json"
            override_path.write_text(json.dumps(override))
            base_only = CascadeConfig.from_file(base_path)
            merged = CascadeConfig.from_file(base_path, override_path)

        # Base-only payload: the contract/data specialist steering.
        base_payload = seat_routing(base_only, "commit-reviewer-a")
        self.assertIsNotNone(base_payload)
        self.assertEqual(base_payload["role"], "r2_contract_data")
        self.assertEqual(base_payload["finding_classes"], ["contract_drift", "data_integrity"])

        # MERGED payload: the override's leaf role/lens change reaches the
        # leaf's seat_routing payload (focus classes follow the new lens).
        payload = seat_routing(merged, "commit-reviewer-a")
        self.assertEqual(payload["role"], "r3_security")
        self.assertEqual(payload["lens"], "security")
        self.assertEqual(payload["finding_classes"], ["security"])
        self.assertFalse(payload["generalist"])

    def test_backup_secondary_receives_generalist_routing(self):
        # C-F3 fixture: an r1_backup_secondary seat is a GENERALIST under
        # GENERALIST_ROLES — lightweight-selection eligible AND steered with
        # GENERALIST routing metadata (never specialist steering).
        cfg = CascadeConfig.from_dict(_shaped_config(
            leaves=_EXPECTED_FREE_LEAVES,
            leaf_roles={
                "commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"},
                "commit-reviewer-b": {"role": "r1_backup_secondary", "lens": "block_finder"},
            },
        ))
        # The lightweight path selects the backup_secondary seat b as the
        # first ACTIVE GENERALIST...
        self.assertEqual(select_lightweight_leaf(cfg), "commit-reviewer-b")
        # ...and its routing metadata is GENERALIST: generalist flag set,
        # generalist directive (no specialist prioritization steering).
        payload = seat_routing(cfg, "commit-reviewer-b")
        self.assertIsNotNone(payload)
        self.assertTrue(payload["generalist"])
        self.assertIn("generalist", payload["directive"].lower())
        self.assertNotIn("prioritize", payload["directive"].lower())

    def test_specialist_payload_names_focus_classes(self):
        # The specialist payload names the lens's focus classes and carries
        # the prioritize directive (attention steering only).
        cfg = CascadeConfig.from_dict(_shaped_config(
            leaves=_EXPECTED_FREE_LEAVES,
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        ))
        payload = seat_routing(cfg, "commit-reviewer-a")
        self.assertFalse(payload["generalist"])
        self.assertEqual(payload["finding_classes"], ["contract_drift", "data_integrity"])
        self.assertIn("prioritize", payload["directive"].lower())

    def test_no_panel_or_no_entry_yields_null(self):
        # Graceful fallback: absent panel section OR leaf without a
        # leaf_roles entry forwards seat_routing: null (generalist default).
        v1 = {
            "schema_version": 1,
            "tiers": [{"name": "solo", "leaves": ["commit-reviewer-b", "commit-reviewer-c"]}],
        }
        cfg_v1 = CascadeConfig.from_dict(v1)
        self.assertIsNone(seat_routing(cfg_v1, "commit-reviewer-b"))

        cfg_v2 = CascadeConfig.from_dict(_shaped_config(leaves=_EXPECTED_FREE_LEAVES))
        cfg_v2.panel.leaf_roles.pop("commit-reviewer-b")
        self.assertIsNone(seat_routing(cfg_v2, "commit-reviewer-b"))


class OverrideLoaderTest(unittest.TestCase):
    """Additive project override at .opencode/repo-configs/review-tiers.json:
    base config stays platform_managed; the override merges over it (dicts
    deep, lists wholesale) and stays entirely operator-owned."""

    def test_override_replaces_tiers_and_merges_leaf_roles(self):
        base = _shaped_config(
            leaves=_EXPECTED_FREE_LEAVES,
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
            disabled_leaves=["commit-reviewer-e"],
        )
        override = {
            "tiers": [{"name": "free", "leaves": _ALL_LEAVES}],
            "panel": {"leaf_roles": {"commit-reviewer-e": {"role": "r3_security", "lens": "security"}}},
        }
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            base_path = tmpdir / "review-tiers.json"
            base_path.write_text(json.dumps(base))
            override_path = tmpdir / "override-review-tiers.json"
            override_path.write_text(json.dumps(override))

            cfg = CascadeConfig.from_file(base_path, override_path)
            # tiers: replaced wholesale by the override (4+1 activation).
            self.assertEqual(cfg.tiers[0].leaves, _ALL_LEAVES)
            self.assertEqual(len(cfg.tiers), 1)
            # panel.leaf_roles: base entries preserved, override's e entry added.
            self.assertEqual(
                cfg.panel.leaf_roles["commit-reviewer-a"].role, "r2_contract_data"
            )
            self.assertEqual(
                cfg.panel.leaf_roles["commit-reviewer-e"].role, "r3_security"
            )
            # The merged 4+1 roster validates (a + e specialists, b/c/d/e... b/c/d
            # generalists => 3 generalists, M=2 -> fixture-prerequisite warning,
            # pinned to the exact DOMAIN-FREE wording — no project IDs).
            warnings = validate_roster(cfg)
            self.assertEqual(len(warnings), 1)
            self.assertEqual(
                warnings[0],
                SPECIALIST_FLOOR_PREREQUISITE.format(
                    n=2, leaves="commit-reviewer-a, commit-reviewer-e"
                ),
            )

    def test_absent_override_leaves_base_unchanged(self):
        base = _shaped_config(
            leaves=_EXPECTED_FREE_LEAVES,
            leaf_roles={"commit-reviewer-a": {"role": "r2_contract_data", "lens": "contract_data"}},
        )
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            base_path = tmpdir / "review-tiers.json"
            base_path.write_text(json.dumps(base))
            missing_override = tmpdir / "does-not-exist.json"

            cfg = CascadeConfig.from_file(base_path, missing_override)
            self.assertEqual(cfg.tiers[0].leaves, _EXPECTED_FREE_LEAVES)
            self.assertFalse(cfg.panel.is_generalist("commit-reviewer-a"))
            self.assertEqual(validate_roster(cfg), [])


class SupportedSchemaVersionsTest(unittest.TestCase):
    """A minimal schema_version 1 config (no panel) must still parse — pins
    backward-compat for SUPPORTED_SCHEMA_VERSIONS = {1, 2}."""

    def test_v1_minimal_parses(self):
        v1 = {
            "schema_version": 1,
            "tiers": [{"name": "solo", "leaves": ["commit-reviewer-x"]}],
        }
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as f:
            json.dump(v1, f)
            path = f.name
        try:
            cfg = CascadeConfig.from_file(path)
            self.assertEqual(cfg.schema_version, 1)
            self.assertEqual(len(cfg.tiers), 1)
            self.assertIsNone(cfg.lightweight_review)
            self.assertIsNone(cfg.panel)
        finally:
            Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
