import {
    StateError,
    humanPlanList,
    listPlans,
    loadSessionIndex,
    printJson,
    resolveCliSessionID,
} from "./state-lib.js";

function main() {
    try {
        const resolved = resolveCliSessionID(process.argv.slice(2));
        const json = resolved.args.includes("--json");
        const state = listPlans(resolved.sessionID);
        const index = loadSessionIndex(state.session_name);

        if (json) {
            printJson(state);
        } else {
            console.log(humanPlanList(state.session_name, index));
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
