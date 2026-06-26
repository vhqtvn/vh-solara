# Compaction-Prevention Policy

> **Source:** `researches/decisions/2026-06-01-compaction-prevent-vs-recover.md`
> **Session workflow:** `docs/ai/opencode-session-workflow.md`

## Policy statement

Prevention is the preferred discipline, not a safety guarantee. Even when
prevention practices are followed perfectly, compaction may still occur during
long research or debugging sessions. When it does, fall back to Item 1b
recovery (compaction-primitives injection via `docs/ai/compaction-primitives.md`).
Prevention failure is not a crisis — it is the expected case for long sessions.

## Session-type discipline

| Session type | Default length | Prevention rule |
|---|---|---|
| Implementation | One task per session | Enforce single-task scope. Use `/handoff-save` before starting a new task in the same session. |
| Research / Debate | Longer allowed | Require `/checkpoint-save` at natural boundaries: after each major finding, before topic shifts. |
| Debugging | Longer allowed | Require `/checkpoint-save` after each diagnostic pivot (hypothesis change, layer change, tool swap). |
| Coordination | Naturally short | No extra prevention needed. |

## Prevention checklist

Before starting a non-trivial session, confirm:

1. **Session started.** Run `/session-start <slug>` to get a task contract.
2. **Scope declared.** State scope explicitly in the task contract (mission, in-scope, out-of-scope).
3. **Budget set.** Define a completion condition: "this session ends when [specific deliverable]."
4. **Boundaries marked.** Use `/checkpoint-save` at natural boundaries (after major findings, before handoffs).
5. **Handoffs saved.** Use `/handoff-save` before handing off to another specialist or starting a new task.

## When compaction happens anyway

1. Stop and assess what context was lost.
2. Open `docs/ai/compaction-primitives.md` for the recovery protocol.
3. Re-inject the task contract, resolved context, and open questions from session memory.
4. Resume. The task contract is the stable anchor; chat history is not.

## Cross-references

- Full session workflow: `docs/ai/opencode-session-workflow.md`
- Source analysis (Option A+B): `researches/decisions/2026-06-01-compaction-prevent-vs-recover.md`
- Compaction-primitives recovery: `docs/ai/compaction-primitives.md`
