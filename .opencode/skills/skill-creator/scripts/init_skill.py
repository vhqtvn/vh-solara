#!/usr/bin/env python3
"""Initialize a repo-local OpenCode skill scaffold.

Target path:
  --path <dir>   Where to create <skill-name>/ (default: .opencode/skills).

In a repo managed by vh-agent-harness the `.opencode/skills/` tree is GENERATED
and overwritten on every `vh-agent-harness update`, so pointing --path there
emits a warning and points you at the overlay path. The intended target for new
skills is an overlay pack:
  .vh-agent-harness/overlays/<pack>/skills
The `.opencode/skills/` default is still correct ONLY when editing
`templates/core/` to develop the harness itself.
"""

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


# The generated skill tree the harness overwrites on every update. A new skill
# scaffolded here in a managed repo would be lost; warn and redirect.
GENERATED_SKILLS_DIR = ".opencode/skills"


def title_case_skill_name(skill_name):
    return " ".join(word.capitalize() for word in skill_name.split("-"))


def is_generated_skills_target(path):
    """True when --path resolves to or under the generated .opencode/skills tree.

    A genuine generated target is `.opencode/skills` or `.opencode/skills/<...>`
    where the `.opencode` is the project's managed tree. Two guards keep this
    from false-positiving:

      1. The harness-development source tree `templates/core/.opencode/skills/...`
         is explicitly EXCLUDED. That tree is the corpus the harness renders FROM,
         so editing it is the documented way to develop the harness itself — not
         a target that gets overwritten. The warning stays silent there.
      2. The `.opencode` anchor uses the LAST matching segment (rfind), so an
         unrelated leading prefix that happens to contain `.opencode` (e.g. a
         global `~/.opencode/projects/<repo>/...` path) cannot cause a
         false positive on a later, unrelated directory.
    """
    try:
        resolved = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    s = str(resolved)
    # Harness-development source tree: never a generated target.
    if "templates/core/.opencode" in s:
        return False
    parts = resolved.parts
    if ".opencode" not in parts:
        return False
    # Anchor on the LAST .opencode segment; the generated skills tree is the
    # `.opencode/skills[/...]` suffix immediately after it.
    last_idx = len(parts) - 1 - parts[::-1].index(".opencode")
    after = parts[last_idx + 1:]
    return len(after) >= 1 and after[0] == "skills"


def warn_if_generated(path):
    if not is_generated_skills_target(path):
        return
    print(
        "WARNING: --path {p} is under the generated {g}/ tree. In a repo managed\n"
        "by vh-agent-harness this tree is overwritten on every `vh-agent-harness\n"
        "update`, so the skill you scaffold here will be lost.\n"
        "  - For a NEW skill in a managed repo, target an overlay pack instead:\n"
        "      --path .vh-agent-harness/overlays/<pack>/skills\n"
        "  - Edit {g}/ ONLY when developing the harness itself (templates/core/).\n"
        "  - See `/harness` and `vh-agent-harness guide` for the full recipe.\n"
        "Proceeding with the requested path.".format(p=path, g=GENERATED_SKILLS_DIR),
        file=sys.stderr,
    )


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
        print("  In a harness-managed repo, target an overlay pack:")
        print("    --path .vh-agent-harness/overlays/<pack>/skills")
        sys.exit(1)

    skill_name = sys.argv[1]
    path = ".opencode/skills"
    if len(sys.argv) >= 4 and sys.argv[2] == "--path":
        path = sys.argv[3]

    warn_if_generated(path)
    result = init_skill(skill_name, path)
    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
