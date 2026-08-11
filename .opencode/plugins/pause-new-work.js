// pause-new-work.js — OpenCode plugin enforcing the repo-scoped pause on NEW
// work at the TaskTool + dispatch-command seam.
//
// This plugin implements the THIRD covered seam (the OpenCode dispatch
// surface). It hooks exactly TWO entrypoints:
//
//   tool.execute.before  — block when input.tool === "task" (the Task /
//                          @subagent dispatch tool). Every dominant dogfood
//                          dispatch path (@subagent, model TaskTool, command
//                          subtasks, background subagents, API dispatch)
//                          converges on this single seam, because @subagent is
//                          model-mediated through TaskTool (resolvePart appends
//                          a synthetic-text instruction telling the model to
//                          call the task tool). A refusal here aborts the
//                          child before it starts.
//
//   command.execute.before — block the narrow set of dispatch commands that
//                          BEGIN NEW DELEGATED WORK (see
//                          PAUSE_BLOCKED_DISPATCH_COMMANDS in the contract
//                          module). Everything else is deliberately allowed.
//
// NAMING HONESTY (load-bearing): this is NOT 'global ESTOP', NOT 'pause every
// agent', NOT an agent-loop interlock, NOT an abort/kill switch. It is a
// repo-scoped pause on NEW work across ENUMERATED dispatch entrypoints. A
// thrown error aborts the child/command before execution (the same throw=abort
// pattern shell-guard.js uses).
//
// DELIBERATELY NOT BLOCKED (the pause-new-only contract — in-flight work and
// ordinary operation must continue):
//   - Ordinary chat (no hook fires for chat at all).
//   - Diagnostic tools: the tool.execute.before hook here ONLY blocks
//     input.tool === "task". A blanket tool.execute.before block would stop an
//     in-flight root turn's next ordinary tool call (read/write/bash/glob/
//     grep), violating pause-NEW-only. Only the Task dispatch tool is blocked.
//   - Recovery / diagnosis / status / closeout commands: /closeout, /status,
//     /task-list, /task-open, /task-review, /checkpoint-*, /session-*,
//     /workstream-*, /docs-sync, /ship-review, /commit-review, /coordination,
//     /repo-map, /read-files, /skill-propose, /plans, /plan-*, /harness,
//     /task-contract-*, /job-cleanup, /backlog-cleanup.
//   - /write-task: creates candidate TRANSPORT, does not begin execution. The
//     pause gate is the activateCoordinationTask ready->working transition in
//     state-lib.js (NOT the /resume-task command) — so drafting must stay
//     available and so must working->working continuation.
//   - /resume-task: NOT command-level blocked. It is the entry point for BOTH
//     ready->working (new dispatch, gated precisely by the JS
//     activateCoordinationTask ready->working gate) AND working->working
//     continuation (in-flight, must stay available). Blanket-blocking the
//     command would forbid continuation under a pause, violating the
//     "in-flight work is never touched" contract.
//   - /task-ready, /task-update, /task-delete: lifecycle/status edits, not
//     execution dispatch.
//
// The sentinel state contract is shared with state-lib.js and bgshell_job.py —
// all three import/port the same module (.opencode/scripts/pause-new-work.js).
// See that file for the authoritative contract table.

import { readPauseState, formatRefusal, isBlockedDispatchCommand } from "../scripts/pause-new-work.js";

export const id = "pause-new-work";

export const server = async () => {
    return {
        "tool.execute.before": async (input, output) => {
            // ONLY the Task dispatch tool. A broader check would catch an
            // in-flight root turn's ordinary tool calls (read/write/bash/...)
            // and violate pause-NEW-only.
            if (input.tool !== "task") {
                return;
            }
            const state = readPauseState();
            if (state.engaged) {
                throw new Error(
                    formatRefusal(
                        "OpenCode TaskTool dispatch (@subagent / new child task).",
                    ),
                );
            }
        },

        "command.execute.before": async (input, output) => {
            // ONLY the narrow new-work-dispatch command set. status /
            // closeout / recovery / diagnosis / review commands pass through.
            if (!isBlockedDispatchCommand(input.command)) {
                return;
            }
            const state = readPauseState();
            if (state.engaged) {
                throw new Error(
                    formatRefusal(
                        `dispatch command /${input.command}.`,
                    ),
                );
            }
        },
    };
};

export const PauseNewWorkPlugin = server;

export default {
    id,
    server,
};
