#!/usr/bin/env python3
"""Validate opencode.jsonc and .opencode/agents/*.md configuration consistency.

Checks:
1. opencode.jsonc parses as valid JSONC (stripped comments).
2. Each agent entry in opencode.jsonc has a non-empty description.
3. Optional fields (mode, color, hidden) are valid when present.
4. Each .opencode/agents/*.md has valid frontmatter with description and mode.

Exit 0 on success, non-zero with message on any violation.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENCODE_JSONC = REPO_ROOT / "opencode.jsonc"
AGENTS_DIR = REPO_ROOT / ".opencode" / "agents"

VALID_MODES = {"subagent", "all", "primary"}
VALID_COLOR_TOKENS = {"info", "success", "secondary", "warning", "accent", "primary", "error"}
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


def _strip_comments(text: str) -> str:
    """Remove single-line (//) and multi-line (/* */) comments, outside strings."""
    result: list[str] = []
    i = 0
    in_string = False
    while i < len(text):
        ch = text[i]

        if in_string:
            result.append(ch)
            if ch == "\\" and i + 1 < len(text):
                i += 1
                result.append(text[i])
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            result.append(ch)
            i += 1
        elif ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            # Single-line comment — skip to end of line
            while i < len(text) and text[i] != "\n":
                i += 1
        elif ch == "/" and i + 1 < len(text) and text[i + 1] == "*":
            # Multi-line comment — skip to */
            i += 2
            while i + 1 < len(text) and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2  # skip */
        else:
            result.append(ch)
            i += 1

    return "".join(result)


def _strip_trailing_commas(text: str) -> str:
    """Remove trailing commas before } or ], outside strings.

    Assumes comments are ALREADY stripped, so the forward lookahead from a comma
    only ever sees whitespace then a structural token. (When comments were still
    present, a comma followed by a // or /* */ comment before the closing bracket
    was wrongly kept, leaving a real trailing comma that broke json.loads on
    valid JSONC — and, via the commit-gate validator, blocked every commit.)
    """
    result: list[str] = []
    i = 0
    in_string = False
    while i < len(text):
        ch = text[i]

        if in_string:
            result.append(ch)
            if ch == "\\" and i + 1 < len(text):
                i += 1
                result.append(text[i])
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            result.append(ch)
            i += 1
        elif ch == ",":
            j = i + 1
            while j < len(text) and text[j] in (" ", "\t", "\n", "\r"):
                j += 1
            if j < len(text) and text[j] in ("}", "]"):
                i += 1  # trailing comma — drop it
            else:
                result.append(ch)
                i += 1
        else:
            result.append(ch)
            i += 1

    return "".join(result)


def strip_jsonc_comments(text: str) -> str:
    """Strip // and /* */ comments AND trailing commas before ]/} (valid JSONC).

    Two passes by design: comments FIRST, then trailing commas. This guarantees
    the trailing-comma lookahead only sees structural tokens, so a legal trailing
    comma followed by comment(s) before the closing bracket is correctly removed.
    A single interleaved pass left such commas in place and json.loads rejected
    valid JSONC (blocking all commits through the commit-gate validator).
    """
    return _strip_trailing_commas(_strip_comments(text))


def validate_jsonc() -> list[str]:
    """Validate opencode.jsonc. Returns list of error strings."""
    errors: list[str] = []

    if not OPENCODE_JSONC.exists():
        errors.append(f"MISSING: {OPENCODE_JSONC} does not exist")
        return errors

    raw = OPENCODE_JSONC.read_text(encoding="utf-8")
    try:
        stripped = strip_jsonc_comments(raw)
        data = json.loads(stripped)
    except json.JSONDecodeError as exc:
        errors.append(f"PARSE ERROR in {OPENCODE_JSONC}: {exc}")
        return errors

    agents = data.get("agent")
    if agents is None:
        errors.append("MISSING: 'agent' section not found in opencode.jsonc")
        return errors
    if not isinstance(agents, dict):
        errors.append("INVALID: 'agent' must be an object")
        return errors

    for name, entry in agents.items():
        if not isinstance(entry, dict):
            errors.append(f"agent.{name}: entry must be an object, got {type(entry).__name__}")
            continue

        # description required, non-empty string
        desc = entry.get("description")
        if desc is None or not isinstance(desc, str) or not desc.strip():
            errors.append(f"agent.{name}: 'description' must be a non-empty string")

        # mode optional, must be valid if present
        mode = entry.get("mode")
        if mode is not None:
            if not isinstance(mode, str) or mode not in VALID_MODES:
                errors.append(
                    f"agent.{name}: 'mode' must be one of {sorted(VALID_MODES)}, got {mode!r}"
                )

        # color optional, must be named token or hex
        color = entry.get("color")
        if color is not None:
            if not isinstance(color, str):
                errors.append(f"agent.{name}: 'color' must be a string, got {type(color).__name__}")
            elif color not in VALID_COLOR_TOKENS and not HEX_COLOR_RE.match(color):
                errors.append(
                    f"agent.{name}: 'color' must be a named token "
                    f"({sorted(VALID_COLOR_TOKENS)}) or hex (#RGB/#RRGGBB/etc), got {color!r}"
                )

        # hidden optional, must be boolean
        hidden = entry.get("hidden")
        if hidden is not None and not isinstance(hidden, bool):
            errors.append(f"agent.{name}: 'hidden' must be boolean, got {type(hidden).__name__}")

    return errors


def parse_frontmatter(text: str) -> dict[str, str] | None:
    """Parse YAML-like frontmatter from markdown text. Returns dict or None."""
    if not text.startswith("---"):
        return None
    end = text.find("---", 3)
    if end == -1:
        return None
    block = text[3:end].strip()
    result: dict[str, str] = {}
    for line in block.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        result[key.strip()] = value.strip()
    return result


def validate_agent_files() -> list[str]:
    """Validate .opencode/agents/*.md frontmatter. Returns list of error strings."""
    errors: list[str] = []

    if not AGENTS_DIR.exists():
        errors.append(f"MISSING: {AGENTS_DIR} directory does not exist")
        return errors

    md_files = sorted(AGENTS_DIR.glob("*.md"))
    if not md_files:
        errors.append(f"EMPTY: no .md files found in {AGENTS_DIR}")
        return errors

    for md_file in md_files:
        rel = md_file.relative_to(REPO_ROOT)
        raw = md_file.read_text(encoding="utf-8")
        fm = parse_frontmatter(raw)

        if fm is None:
            errors.append(f"{rel}: no valid frontmatter (--- delimited) found")
            continue

        # description required
        desc = fm.get("description")
        if not desc or not desc.strip():
            errors.append(f"{rel}: 'description' field missing or empty in frontmatter")

        # mode required
        mode = fm.get("mode")
        if not mode or not mode.strip():
            errors.append(f"{rel}: 'mode' field missing in frontmatter")
        elif mode not in VALID_MODES:
            errors.append(
                f"{rel}: 'mode' must be one of {sorted(VALID_MODES)}, got {mode!r}"
            )

    return errors


def main() -> int:
    all_errors: list[str] = []

    all_errors.extend(validate_jsonc())
    all_errors.extend(validate_agent_files())

    if all_errors:
        print("opencode-config validation FAILED:", file=sys.stderr)
        for err in all_errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print("opencode-config validation: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
