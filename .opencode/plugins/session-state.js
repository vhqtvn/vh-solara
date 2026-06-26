import {
    StateError,
    buildCompactionContext,
    ensureSessionBinding,
} from "../scripts/state-lib.js";

export const id = "session-state";

export const server = async ({ client, directory }) => {
    return {
        event: async ({ event }) => {
            if (event.type === "session.created") {
                const info = event.properties.info;
                ensureSessionBinding(info.id, {
                    cwd: info.directory || directory,
                    parentSessionID: info.parentID || null,
                });
            }
        },
        "shell.env": async (input, output) => {
            if (input.sessionID) {
                output.env.OPENCODE_SESSION_ID = input.sessionID;
                output.env.OPENCODE_CWD = directory;
            }
        },
        "experimental.session.compacting": async (input, output) => {
            try {
                const todoResponse = await client.session.todo({
                    sessionID: input.sessionID,
                    directory,
                });
                const todos =
                    todoResponse && !todoResponse.error
                        ? todoResponse.data || []
                        : [];
                output.context.push(
                    ...buildCompactionContext(input.sessionID, todos),
                );
            } catch (error) {
                if (error instanceof StateError) {
                    output.context.push("Session alias: (unbound)");
                    output.context.push(error.message);
                    return;
                }
                throw error;
            }
        },
    };
};

export default {
    id,
    server,
};
