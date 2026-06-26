import {
    StateError,
    approveDraft,
    printJson,
    resolveCliSessionID,
} from "./state-lib.js";

function main() {
    try {
        const resolved = resolveCliSessionID(process.argv.slice(2));
        const json = resolved.args.includes("--json");
        const positional = resolved.args.filter((arg) => arg !== "--json");
        const slug = positional[0] || "";
        if (!slug.trim()) {
            throw new StateError("Provide a draft slug to approve.");
        }

        const result = approveDraft(resolved.sessionID, slug);
        if (json) {
            printJson(result);
        } else {
            console.log(`Approved plan: ${result.plan.id}`);
            console.log(`Session alias: ${result.session_name}`);
            console.log(`OpenCode sessionID: ${result.session_id}`);
            console.log(`Draft path: ${result.draft_path}`);
        }
        return 0;
    } catch (error) {
        if (error instanceof StateError) {
            console.error(error.message);
            return 1;
        }
        throw error;
    }
}

process.exitCode = main();
