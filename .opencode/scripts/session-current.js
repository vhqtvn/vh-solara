import {
    StateError,
    currentSessionBinding,
    printJson,
    resolveCliSessionID,
} from "./state-lib.js";

function main() {
    try {
        const resolved = resolveCliSessionID(process.argv.slice(2));
        const json = resolved.args.includes("--json");
        const binding = currentSessionBinding(resolved.sessionID);
        if (json) {
            printJson(binding);
        } else {
            console.log(binding.session_name);
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
