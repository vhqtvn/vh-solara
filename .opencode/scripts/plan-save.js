import fs from "fs";
import {
    StateError,
    printJson,
    resolveCliSessionID,
    savePlan,
} from "./state-lib.js";

function main() {
    try {
        const resolved = resolveCliSessionID(process.argv.slice(2));
        let slug = "";
        let title = "";
        let bodyFile = "";
        let json = false;

        for (let index = 0; index < resolved.args.length; index += 1) {
            const arg = resolved.args[index];
            if (arg === "--json") {
                json = true;
            } else if (arg === "--title") {
                title = resolved.args[index + 1] || "";
                index += 1;
            } else if (arg === "--body-file") {
                bodyFile = resolved.args[index + 1] || "";
                index += 1;
            } else if (!slug) {
                slug = arg;
            } else {
                throw new StateError(`Unexpected argument: ${arg}`);
            }
        }

        const body = bodyFile
            ? fs.readFileSync(bodyFile, "utf8")
            : fs.readFileSync(0, "utf8");
        const result = savePlan(resolved.sessionID, slug, body, title);
        if (json) {
            printJson(result);
        } else {
            console.log(`Saved plan: ${result.plan.id}`);
            console.log(`Session alias: ${result.session_name}`);
            console.log(`OpenCode sessionID: ${result.session_id}`);
            console.log(`Path: ${result.plan.path}`);
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
