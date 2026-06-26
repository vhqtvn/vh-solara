/**
 * MaxOutputTokens Plugin — pattern-keyed watchdog for token caps.
 *
 * Hooks into chat.params to enforce a maxOutputTokens cap on LLM requests
 * that opt in via the rule table below.  Models not matching any rule are
 * SKIPPED entirely — no field is injected.
 *
 * Design: pattern-keyed opt-in allowlist
 * ───────────────────────────────────────
 * Previous versions applied maxOutputTokens to every model unconditionally
 * and wrote to `output.options.maxOutputTokens`.  Both were wrong:
 *
 *   1. The chat.params output schema declares `maxOutputTokens` as a
 *      top-level field, NOT inside `output.options`.  Writing into
 *      `output.options` caused it to leak as an extra/unknown parameter
 *      into provider-specific request bodies.
 *
 *   2. Bedrock Anthropic (claude-opus-4-7) rejects unknown parameters
 *      with HTTP 400 "Extra inputs are not permitted".  A blanket rule
 *      broke commit-reviewer Leaf A entirely.
 *
 * The new design uses an explicit allowlist.  Only models whose key
 * (providerID/id) matches a rule receive injection.  Bedrock / Anthropic
 * Claude is intentionally excluded — it uses `max_tokens`, not
 * `maxOutputTokens`, and will reject the parameter.
 *
 * Defense layers (unchanged):
 *   1. provider.options.timeout + chunkTimeout  (opencode.jsonc)  — kills stuck streams
 *   2. maxOutputTokens via this plugin          (chat.params)     — caps output size
 *
 * See: researches/decisions/2026-05-29-harness-improvement-plan.md Item 6
 * See: researches/decisions/2026-06-01-watchdog-spike-findings.md
 */

export const id = "maxoutputtokens";

// Set to false to disable the plugin without deleting the file.
const ENABLED = true;

/**
 * Rule table: first match wins, unmatched models are skipped.
 *
 * Each entry: { pattern: RegExp, maxOutputTokens: number }
 *   - pattern is tested against "<providerID>/<modelID>"
 *   - Bedrock / Anthropic Claude is explicitly excluded because it
 *     rejects maxOutputTokens ("Extra inputs are not permitted").
 */
const MAX_OUTPUT_TOKEN_RULES = [
    { pattern: /zai-coding-plan/i, maxOutputTokens: 65536 },
    { pattern: /glm/i, maxOutputTokens: 65536 },
];

/**
 * Find the first matching rule for a model key, or null if none match.
 * Exported for testability.
 */
export function findRule(modelKey) {
    for (const rule of MAX_OUTPUT_TOKEN_RULES) {
        if (rule.pattern.test(modelKey)) return rule;
    }
    return null;
}

export const server = async () => {
    return {
        "chat.params": async (input, output) => {
            if (!output) return;
            if (!ENABLED) return;

            // Build the match key from providerID and model id.
            // SDK Model type uses `id` (not `modelID`).
            const modelKey = `${input.model?.providerID ?? ""}/${input.model?.id ?? ""}`;

            const rule = findRule(modelKey);
            if (!rule) return; // unmatched → skip injection entirely

            const cap = rule.maxOutputTokens;

            // Set the top-level field per the chat.params output schema (see
            // @opencode-ai/plugin/dist/index.d.ts line 209).  The previous
            // version wrote to output.options.maxOutputTokens, which may have
            // caused the param to leak as an extra/unknown field into
            // provider-specific request bodies (triggering Bedrock's
            // "Extra inputs are not permitted").
            const current = output.maxOutputTokens;
            if (current === undefined || current === null || current > cap) {
                output.maxOutputTokens = cap;
            }
        },
    };
};

export default { id, server };
