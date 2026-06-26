// .opencode/plugins/compaction-primitives.js
// Compaction hook: injects a compact operational-primitives rule block
// into every compaction context so critical routing/primitive rules survive compaction.

export const id = "compaction-primitives";

export const server = async ({ client, directory }) => {
    return {
        "experimental.session.compacting": async (input, output) => {
            output.context.push(
                `## Operational Primitives (injected by compaction-primitives plugin)

### Container & Dev Environment
- Run all commands through \`vh-agent-harness exec <cmd>\` — never use host-level python/node/pytest/npm directly.
- Dev compose has no \`container_name\` declarations; Docker Compose auto-names as \`vh-solara-<service>-1\` (e.g., \`vh-solara-dev-1\`, \`vh-solara-api-1\`).
- API base inside container: project-supplied (see project overlay).
- Demo credentials / API routes: project-supplied. A consuming project appends its
  concrete block here (see compaction-primitives.project.example.md overlay).

### Git Mutation Routing
- Only the \`committer\` agent (C) may execute git mutations, through the gated-commit protocol.
- All other agents MUST delegate to \`committer\` for any git write. See \`.opencode/docs/git-execution-routing.md\`.
- Operator escape hatch: SKIP_COMMIT_GATE=1 suppresses only the git-mutation-bypass forbidden-pattern check (all other patterns remain enforced); commit-gate.sh also enters bypass mode under this flag.

### Shell Guard
- The shell-guard plugin refuses high-risk patterns (Docker socket, apt installs, JWT secrets on CLI, etc.).
- Do NOT paraphrase commands to evade the guard — read the rule's \`why\` and use the canonical alternative.

### Temporary File Hygiene
- Use \`./tmp/\` for transient artifacts — never system \`/tmp/\`.
- Never commit \`./tmp/\` contents or ad hoc scratch files.
- Clean up temporary scripts/logs/downloads when the task completes.

Reference: docs/ai/codebase-operational-primitives.md (canonical source)`,
            );
        },
    };
};

export default {
    id,
    server,
};
