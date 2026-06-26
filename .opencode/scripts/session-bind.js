import {
    StateError,
    bindSessionName,
    printJson,
    resolveCliSessionID,
} from "./state-lib.js";

function main() {
    try {
        const resolved = resolveCliSessionID(process.argv.slice(2));
        const json = resolved.args.includes("--json");
        const positional = resolved.args.filter((arg) => arg !== "--json");
        const sessionName = positional[0] || "";
        const binding = bindSessionName(resolved.sessionID, sessionName);

        const payload = {
            ...binding,
            requested_session_name: sessionName,
        };
        if (json) {
            printJson(payload);
        } else {
            console.log(`Active session alias: ${payload.session_name}`);
            console.log(`OpenCode sessionID: ${payload.session_id}`);
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
