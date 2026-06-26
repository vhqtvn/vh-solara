#!/usr/bin/env python3
"""Quick validator for repo-local OpenCode skill folders."""

import re
import sys
from pathlib import Path

import yaml


ALLOWED_PROPERTIES = {"name", "description", "license", "compatibility", "metadata"}


def validate_skill(skill_path):
    skill_path = Path(skill_path)
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text()
    if not content.startswith("---"):
        return False, "No YAML frontmatter found"

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        return False, f"Invalid YAML in frontmatter: {exc}"

    if not isinstance(frontmatter, dict):
        return False, "Frontmatter must be a YAML dictionary"

    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES
    if unexpected_keys:
        return False, (
            f"Unexpected frontmatter key(s): {', '.join(sorted(unexpected_keys))}. "
            f"Allowed keys: {', '.join(sorted(ALLOWED_PROPERTIES))}"
        )

    name = frontmatter.get("name")
    if not isinstance(name, str) or not name.strip():
        return False, "Missing or invalid 'name' in frontmatter"
    name = name.strip()
    if not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", name):
        return False, "name must be lowercase alphanumeric with single hyphen separators"
    if len(name) > 64:
        return False, "name is too long; maximum is 64 characters"
    if skill_path.name != name:
        return False, f"name '{name}' must match the directory name '{skill_path.name}'"

    description = frontmatter.get("description")
    if not isinstance(description, str) or not description.strip():
        return False, "Missing or invalid 'description' in frontmatter"
    if len(description.strip()) > 1024:
        return False, "description is too long; maximum is 1024 characters"
    if "<" in description or ">" in description:
        return False, "description cannot contain angle brackets"

    compatibility = frontmatter.get("compatibility")
    if compatibility is not None and compatibility != "opencode":
        return False, "compatibility must be 'opencode' when provided"

    return True, "Skill is valid"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
