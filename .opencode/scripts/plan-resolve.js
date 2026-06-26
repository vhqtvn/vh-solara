import {
    StateError,
    printJson,
    resolveCliSessionID,
    resolvePlan,
} from "./state-lib.js";

function main() {
    try {
        const resolved = resolveCliSessionID(process.argv.slice(2));
        let selector = "";
        let json = false;
        let body = false;
        let filePath = false;

        for (const arg of resolved.args) {
            if (arg === "--json") {
                json = true;
            } else if (arg === "--body") {
                body = true;
            } else if (arg === "--path") {
                filePath = true;
            } else if (!selector) {
                selector = arg;
            } else {
                throw new StateError(`Unexpected argument: ${arg}`);
            }
        }

        const result = resolvePlan(resolved.sessionID, selector);
        if (body) {
            process.stdout.write(result.body.replace(/\s*$/, ""));
        } else if (filePath) {
            console.log(result.path);
        } else if (json) {
            printJson(result);
        } else {
            console.log(`Resolved plan: ${result.plan.id}`);
            console.log(`Session alias: ${result.session_name}`);
            console.log(`OpenCode sessionID: ${result.session_id}`);
            console.log(`Resolved via: ${result.resolved_via}`);
            console.log(`Path: ${result.path}`);
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
