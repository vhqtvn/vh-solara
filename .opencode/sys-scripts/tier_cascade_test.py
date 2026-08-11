"""
Regression baseline for the shipped review-tiers.json against the Python
cascade loader (``CascadeConfig.from_file``).

This is the thin parse-baseline identified by DEFER card
``defer-018-tier-cascade-v2-regression-test`` as doable NOW. It pins the
contract that the REAL committed config (``.opencode/config/review-tiers.json``,
source at ``templates/core/.opencode/config/review-tiers.json``) loads cleanly
through the real loader under ``schema_version`` 2, and that the schema-v2
``panel`` block is ACCEPTED-but-IGNORED by the parser (the panel is inert
routing metadata until a future parser edit consults it).

The full ignore/consult regression (quorum / seat resolution through
``run_cascade``) genuinely needs a parser edit and is intentionally out of
scope here — see the card's TRUE-FUTURE scope.

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

from tier_cascade import CascadeConfig  # noqa: E402  (sys.path set up above)

# The REAL shipped config lives at <root>/.opencode/config/review-tiers.json.
# From <root>/.opencode/sys-scripts/ that is ../config/review-tiers.json.
CONFIG_PATH = _HERE.parent / "config" / "review-tiers.json"

# Lever E panel: the active "free" tier carries a fixed 4-leaf count, with
# commit-reviewer-a as the contract/data-integrity specialist seat and
# b/c/d as independently-attributable redundant generalists.
_EXPECTED_FREE_LEAVES = [
    "commit-reviewer-a",
    "commit-reviewer-b",
    "commit-reviewer-c",
    "commit-reviewer-d",
]


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

    def test_panel_block_present_but_ignored(self):
        # CONTRACT PIN (the defer-018 discriminator): schema_version 2 ships a
        # ``panel`` block, and the parser MUST accept it without error while
        # exposing NO panel-derived field on CascadeConfig. The panel is inert
        # routing metadata. If a future edit makes the loader consult the panel
        # (adding a panel field / branching on it), this assertion fails and
        # forces the author to update the test consciously — which is exactly
        # the UPGRADES-TO-BLOCK reactivation condition recorded on the card.
        self.assertIsInstance(self.raw.get("panel"), dict)
        cfg = CascadeConfig.from_file(CONFIG_PATH)  # must not raise
        self.assertFalse(
            hasattr(cfg, "panel"),
            "CascadeConfig must not expose a 'panel' field while the panel is inert",
        )


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
        finally:
            Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
