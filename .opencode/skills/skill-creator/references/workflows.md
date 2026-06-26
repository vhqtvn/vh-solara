# Workflow Patterns

These patterns are for repo-local OpenCode skills in engineering repositories.

## Sequential Workflows

For complex tasks, break operations into clear, sequential steps. It is often helpful to give the agent an overview near the beginning of `SKILL.md`:

```markdown
1. Read the boundary docs.
2. Locate the repeated path or decision.
3. Apply the workflow.
4. Validate the result.
5. Summarize the outcome.
```

## Conditional Workflows

For tasks with branching logic, guide the agent through decision points:

```markdown
1. Determine the task shape:
   **Creating a new skill?** -> Follow "Creation workflow"
   **Updating an existing skill?** -> Follow "Update workflow"

2. Creation workflow: [steps]
3. Update workflow: [steps]
```

## Session-Mining Workflow

Use this when the repo already has historical OpenCode evidence:

```markdown
1. Find archived sessions, prompts, or repeated commands for the target workflow.
2. Identify repeated hotspots, decision points, and output expectations.
3. Distill only the reusable parts into `SKILL.md`.
4. Push bulky detail into `references/` only if needed.
5. Validate that the description is explicit enough to trigger reliably.
```
