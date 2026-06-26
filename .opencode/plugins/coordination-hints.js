import { buildCoordinationHintMessages } from "../scripts/coordination-hints-lib.js";

export const id = "coordination-hints";

const shownHintsBySession = new Map();

async function showHintToast(client, directory, hint) {
    await client.tui.showToast({
        query: {
            directory,
        },
        body: {
            title: hint.title,
            message: hint.message,
            variant: hint.variant,
            duration: 5000,
        },
    });
}

export const server = async ({ client, directory }) => {
    return {
        event: async ({ event }) => {
            if (event.type === "session.deleted") {
                shownHintsBySession.delete(event.properties.info.id);
                return;
            }
            if (event.type !== "session.diff") {
                return;
            }

            const sessionID = event.properties.sessionID;
            const hints = buildCoordinationHintMessages({
                directory,
                diffFiles: event.properties.diff || [],
            });
            if (!hints.length) {
                return;
            }

            const seen = shownHintsBySession.get(sessionID) || new Set();
            for (const hint of hints) {
                if (seen.has(hint.key)) {
                    continue;
                }
                await showHintToast(client, directory, hint);
                seen.add(hint.key);
            }
            shownHintsBySession.set(sessionID, seen);
        },
    };
};

export const CoordinationHintsPlugin = server;

export default {
    id,
    server,
};

