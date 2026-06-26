#!/usr/bin/env python3
"""Initialize a repo-local OpenCode skill scaffold."""

import sys
from pathlib import Path


SKILL_TEMPLATE = """---
name: {skill_name}
description: COMPLETE: add skill description here. use lowercase. include explicit trigger phrases such as "use this when..."
compatibility: opencode
---

# {skill_title}

## Overview

FILL IN: 1-2 sentences explaining what repeated workflow this skill captures

## When to use

FILL IN: list the trigger conditions

## When not to use

FILL IN: list nearby tasks or skills this should not cover

## Workflow

FILL IN: add the minimum reusable steps

## Output

FILL IN: describe the expected response shape
"""

EXAMPLE_REFERENCE = """# Reference Notes for {skill_title}

Put bulky or variant-specific detail here only if it would make `SKILL.md` too large or too noisy.

Suggested uses:
- file hotspots
- branching rules
- validation commands
- short examples
"""


def title_case_skill_name(skill_name):
    return " ".join(word.capitalize() for word in skill_name.split("-"))


def init_skill(skill_name, path):
    skill_dir = Path(path).resolve() / skill_name

    if skill_dir.exists():
        print(f"Error: skill directory already exists: {skill_dir}")
        return None

    try:
        skill_dir.mkdir(parents=True, exist_ok=False)
        (skill_dir / "SKILL.md").write_text(
            SKILL_TEMPLATE.format(skill_name=skill_name, skill_title=title_case_skill_name(skill_name))
        )
        references_dir = skill_dir / "references"
        references_dir.mkdir()
        (references_dir / "example.md").write_text(
            EXAMPLE_REFERENCE.format(skill_title=title_case_skill_name(skill_name))
        )
        print(f"Created skill scaffold at: {skill_dir}")
        print("Next steps:")
        print("1. Edit SKILL.md")
        print("2. Remove references/example.md if you do not need it")
        print("3. Add scripts/ or assets/ only when they materially help")
        print(f"4. Validate with quick_validate.py")
        return skill_dir
    except Exception as exc:
        print(f"Error creating skill scaffold: {exc}")
        return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python init_skill.py <skill-name> [--path .opencode/skills]")
        sys.exit(1)

    skill_name = sys.argv[1]
    path = ".opencode/skills"
    if len(sys.argv) >= 4 and sys.argv[2] == "--path":
        path = sys.argv[3]

    result = init_skill(skill_name, path)
    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
