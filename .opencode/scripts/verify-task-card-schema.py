from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft7Validator, FormatChecker


REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    REPO_ROOT / "docs" / "coordination" / "schemas" / "task-card.schema.json"
)


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def build_base_task() -> dict:
    return {
        "schema_version": 1,
        "task_id": "task-verify-schema",
        "title": "Verify task-card schema",
        "task_type": "research",
        "coordination_mode": "medium",
        "primary_lane": "repo",
        "research_question": "How should long-running research be prepared and resumed?",
        "source_policy": "web_repo",
        "source_allowlist": ["docs.anthropic.com", "openai.com"],
        "desired_artifact_type": "sources",
        "target_artifact_path": "researches/sources/2026-04-30-long-research-workflow-sources.md",
        "rough_scope": [],
        "open_questions": [],
        "ready_criteria": [],
        "files_in_scope": ["docs/coordination/schemas/task-card.schema.json"],
        "constraints": ["Keep validation self-contained."],
        "non_goals": ["No product-code changes."],
        "success_criteria": ["Schema fixtures validate correctly."],
        "validation_plan": ["Run verify-task-card-schema.py."],
        "report_envelope": "standard",
        "backlog_id": "P0-REPO-062",
        "workstream_slug": None,
        "dependencies": [],
        "owner_notes": [],
        "status": "ready",
        "session_aliases": ["verify-schema"],
        "active_session_alias": None,
        "claimed_at": None,
        "report_paths": [],
        "review_paths": [],
        "latest_report": None,
        "next_action": "Resume when needed.",
        "last_review": None,
        "history": [
            {
                "at": "2026-04-30T00:00:00Z",
                "event": "task_created",
                "session_name": "verify-schema",
                "status": "ready",
                "note": "Fixture created for schema validation.",
            }
        ],
        "created_at": "2026-04-30T00:00:00Z",
        "updated_at": "2026-04-30T00:00:00Z",
    }


def validate_ok(name: str, payload: dict, validator: Draft7Validator) -> None:
    errors = sorted(validator.iter_errors(payload), key=lambda error: list(error.path))
    if errors:
        details = "; ".join(error.message for error in errors)
        raise AssertionError(f"{name} should be valid, but failed: {details}")


def validate_fail(name: str, payload: dict, validator: Draft7Validator) -> None:
    errors = sorted(validator.iter_errors(payload), key=lambda error: list(error.path))
    if not errors:
        raise AssertionError(f"{name} should be invalid, but passed validation")


def main() -> None:
    schema = load_schema()
    validator = Draft7Validator(schema, format_checker=FormatChecker())

    ready_task = build_base_task()

    draft_task = deepcopy(ready_task)
    draft_task["status"] = "draft"
    draft_task["rough_scope"] = ["Map the remaining coordinator edge cases."]
    draft_task["files_in_scope"] = []
    draft_task["success_criteria"] = []
    draft_task["validation_plan"] = []
    draft_task["active_session_alias"] = None
    draft_task["claimed_at"] = None
    draft_task["history"][0]["status"] = "draft"

    working_task = deepcopy(ready_task)
    working_task["status"] = "working"
    working_task["active_session_alias"] = "verify-subagent"
    working_task["claimed_at"] = "2026-04-30T00:05:00Z"
    working_task["session_aliases"] = ["verify-schema", "verify-subagent"]
    working_task["history"][0]["status"] = "working"

    reviewed_task = deepcopy(ready_task)
    reviewed_task["status"] = "completed"
    reviewed_task["review_paths"] = [
        ".local/coordinator/reports/task-verify-schema/2026-04-30T00-15-00Z-review.md"
    ]
    reviewed_task["last_review"] = {
        "path": ".local/coordinator/reports/task-verify-schema/2026-04-30T00-15-00Z-review.md",
        "reviewed_at": "2026-04-30T00:15:00Z",
        "session_name": "verify-coordinator",
        "title": "Coordinator review",
        "status": "ready",
        "summary": "Return the task to ready for one follow-up pass.",
        "next_action": "Resume the task in a bound subagent session.",
    }

    invalid_draft = deepcopy(draft_task)
    invalid_draft["rough_scope"] = []
    invalid_draft["open_questions"] = []
    invalid_draft["ready_criteria"] = []

    invalid_research_missing_question = deepcopy(ready_task)
    invalid_research_missing_question["research_question"] = ""

    invalid_research_missing_policy = deepcopy(ready_task)
    invalid_research_missing_policy["source_policy"] = None

    invalid_research_missing_artifact_type = deepcopy(ready_task)
    invalid_research_missing_artifact_type["desired_artifact_type"] = None

    invalid_research_missing_artifact_path = deepcopy(ready_task)
    invalid_research_missing_artifact_path["target_artifact_path"] = None

    invalid_ready = deepcopy(ready_task)
    invalid_ready["files_in_scope"] = []

    invalid_working = deepcopy(working_task)
    invalid_working["active_session_alias"] = None
    invalid_working["claimed_at"] = None

    invalid_reviewed = deepcopy(reviewed_task)
    del invalid_reviewed["last_review"]["path"]

    validate_ok("draft_task", draft_task, validator)
    validate_ok("ready_task", ready_task, validator)
    validate_ok("working_task", working_task, validator)
    validate_ok("reviewed_task", reviewed_task, validator)
    validate_fail("invalid_draft", invalid_draft, validator)
    validate_fail(
        "invalid_research_missing_question",
        invalid_research_missing_question,
        validator,
    )
    validate_fail(
        "invalid_research_missing_policy",
        invalid_research_missing_policy,
        validator,
    )
    validate_fail(
        "invalid_research_missing_artifact_type",
        invalid_research_missing_artifact_type,
        validator,
    )
    validate_fail(
        "invalid_research_missing_artifact_path",
        invalid_research_missing_artifact_path,
        validator,
    )
    validate_fail("invalid_ready", invalid_ready, validator)
    validate_fail("invalid_working", invalid_working, validator)
    validate_fail("invalid_reviewed", invalid_reviewed, validator)

    print("schema_verification: ok")
    print(
        "validated_examples: draft ready working reviewed invalid_draft invalid_research_missing_question invalid_research_missing_policy invalid_research_missing_artifact_type invalid_research_missing_artifact_path invalid_ready invalid_working invalid_reviewed"
    )


if __name__ == "__main__":
    main()
