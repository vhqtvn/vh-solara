import {
    buildCoordinationHintMessages,
    buildRepetitionHint,
    normalizeCommandIdentity,
} from "../scripts/coordination-hints-lib.js";

export const id = "coordination-hints";

// Anti-spam: a hint fires at most once per (sessionID, hint.key) across both
// the session.diff path triggers and the command.executed signal trigger.
const shownHintsBySession = new Map();
// Per-session normalized command shape -> occurrence count. C10: surfaces
// repeated command shapes that the session.diff path/content triggers cannot
// see (the repetition signal lives in command.executed, independent of file
// diffs). Cleared on session.deleted to bound memory.
const commandHistoryBySession = new Map();

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
                commandHistoryBySession.delete(event.properties.info.id);
                return;
            }
            if (event.type === "command.executed") {
                const sessionID = event.properties.sessionID;
                const identity = normalizeCommandIdentity(
                    event.properties.name,
                    event.properties.arguments,
                );
                const counts = commandHistoryBySession.get(sessionID) || new Map();
                const next = (counts.get(identity) || 0) + 1;
                counts.set(identity, next);
                commandHistoryBySession.set(sessionID, counts);
                const hint = buildRepetitionHint(identity, next);
                if (!hint) {
                    return;
                }
                // Reuse the SAME Anti-spam set as the diff hints so a repetition
                // toast fires at most once per (session, key).
                const seen = shownHintsBySession.get(sessionID) || new Set();
                if (seen.has(hint.key)) {
                    return;
                }
                // Reserve the key SYNCHRONOUSLY before the await: under
                // fire-and-forget event dispatch a second event re-entering the
                // handler during the toast RPC would otherwise read a Set that
                // still lacks the key and fire a duplicate. Anti-spam is
                // "at most once per (session, key)", no exceptions.
                seen.add(hint.key);
                shownHintsBySession.set(sessionID, seen);
                await showHintToast(client, directory, hint);
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
            // Publish the Set reference to the map BEFORE the loop so a
            // re-entrant event arriving during an intra-loop await reads the
            // SAME Set (in-place mutation by seen.add below stays visible to
            // it). Anti-spam: at most once per (session, key), no exceptions —
            // same discipline as the command.executed branch above.
            shownHintsBySession.set(sessionID, seen);
            for (const hint of hints) {
                if (seen.has(hint.key)) {
                    continue;
                }
                seen.add(hint.key);
                await showHintToast(client, directory, hint);
            }
        },
    };
};

export const CoordinationHintsPlugin = server;

export default {
    id,
    server,
};

