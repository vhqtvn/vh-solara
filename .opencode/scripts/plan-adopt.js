import {
    StateError,
    adoptPlan,
    printJson,
    resolveCliSessionID,
} from "./state-lib.js";

function main() {
    try {
        const resolved = resolveCliSessionID(process.argv.slice(2));
        const json = resolved.args.includes("--json");
        const positional = resolved.args.filter((arg) => arg !== "--json");
        const selector = positional[0] || "";
        if (!selector.trim()) {
            throw new StateError(
                "Provide a plan id or unique prefix to adopt.",
            );
        }

        const result = adoptPlan(resolved.sessionID, selector);
        if (json) {
            printJson(result);
        } else {
            console.log(`Adopted plan: ${result.plan.id}`);
            console.log(`Session alias: ${result.session_name}`);
            console.log(`OpenCode sessionID: ${result.session_id}`);
            console.log(`Title: ${result.plan.title}`);
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
