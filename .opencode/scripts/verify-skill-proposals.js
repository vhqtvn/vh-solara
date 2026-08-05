// Skill-authoring proposal transport verification (CC borrowable #4).
//
// Permanent regression suite for the skill-proposal subsystem in state-lib.js,
// mirroring verify-task-registry.js / verify-skill-sentinel.js. Exercises the
// full candidate-vs-authority contract end to end:
//   1. Create new proposal -> draft stamped, nested provenance, top-level
//      created_by REFUSED.
//   2. Update an existing draft (B1 regression): the status-preserving save
//      MUST NOT throw. Before the B1 fix this path deterministically threw
//      because the save routed a draft->draft preservation check through a
//      transition validator whose current===next branch rejects non-transitions.
//   3. list / read surface the draft.
//   4. draft -> accepted (human gate): acceptance creates NO skill (no
//      SKILL.md is written anywhere under .opencode/skills/).
//   5. accepted -> rejected REFUSED (terminal freeze: accepted is closed).
//   6. draft -> rejected -> terminal.
//   7. deleteSkillProposal retires the transport card (file gone).
//   8. Provenance is stamped by the TRANSPORT from the real session, not
//      trusted from the caller (a forged metadata.proposal-origin and forged
//      proposing_session_name are overwritten/ignored).
//
// Run: `node .opencode/scripts/verify-skill-proposals.js` (rendered tree).
import fs from "fs";
import path from "path";
import {
    StateError,
    bindSessionName,
    saveSkillProposal,
    readSkillProposal,
    listSkillProposals,
    setSkillProposalStatus,
    deleteSkillProposal,
    repoRoot,
} from "./state-lib.js";

function proposalsRoot() {
    return path.join(repoRoot(), ".local", "coordinator", "skill-proposals");
}

function proposalCardPath(proposalID) {
    return path.join(proposalsRoot(), `${proposalID}.json`);
}

function proposalLockPath(proposalID) {
    return path.join(proposalsRoot(), `.${proposalID}.lock`);
}

function removeIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

// Pre-clean only fixture cards this verifier owns (generated ids embed the
// prefix via the skill_slug; hand-authored proposals are untouched). Makes the
// suite idempotent across re-runs so a failed earlier run cannot leave a
// stale draft that interferes with the next.
function preCleanFixtures(prefix) {
    const dir = proposalsRoot();
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        if (!name.includes(prefix)) continue;
        if (name.endsWith(".json") || (name.startsWith(".") && name.endsWith(".lock"))) {
            removeIfExists(path.join(dir, name));
        }
    }
}

function cleanupArtifacts(proposalIDs) {
    for (const proposalID of proposalIDs) {
        removeIfExists(proposalCardPath(proposalID));
        removeIfExists(proposalLockPath(proposalID));
    }
}

function expectStateError(fn, expectedFragment) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof StateError)) {
        throw new StateError(
            `Expected StateError containing "${expectedFragment}", but got ${thrown ? thrown.constructor.name : "no error"}.`,
        );
    }
    if (!String(thrown.message || "").includes(expectedFragment)) {
        throw new StateError(
            `Expected error containing "${expectedFragment}", got "${thrown.message}".`,
        );
    }
}

// Derive the CANONICAL proposal id from the on-disk path (always
// slug-normalized lowercase). generateSkillProposalId now pre-normalizes its
// return (D2 fix), so result.proposal.proposal_id equals this path stem from
// the moment of creation; previously the raw planTimestamp-bearing id diverged
// in case from the slug-lowercased filename until the first re-normalizing
// update converged them. Path-derived remains the canonical source of truth
// for cleanup and string-equality regardless, so this helper stays.
function canonicalProposalId(result) {
    return path.basename(result.path, ".json");
}

// Snapshot the set of SKILL.md files under .opencode/skills/ so the
// "acceptance creates NO skill" assertion can prove no file materialized.
function snapshotSkillFiles() {
    const root = path.join(repoRoot(), ".opencode", "skills");
    if (!fs.existsSync(root)) return new Set();
    const out = new Set();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            const skillMd = path.join(root, entry.name, "SKILL.md");
            if (fs.existsSync(skillMd)) {
                out.add(path.relative(repoRoot(), skillMd));
            }
        }
    }
    return out;
}

function main() {
    const args = process.argv.slice(2);
    let prefix = "verify-skill-proposals";
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--prefix") {
            prefix = args[index + 1] || prefix;
            index += 1;
            continue;
        }
        throw new StateError(`Unexpected argument: ${args[index]}`);
    }

    const proposingSessionID = `${prefix}-proposing-session`;
    const humanSessionID = `${prefix}-human-session`;
    const createdProposalIDs = [];
    const trackID = (result) => {
        const id = canonicalProposalId(result);
        if (id && !createdProposalIDs.includes(id)) {
            createdProposalIDs.push(id);
        }
        return id;
    };

    try {
        bindSessionName(proposingSessionID, `${prefix}-proposer`, {
            cwd: "/verification",
        });
        bindSessionName(humanSessionID, `${prefix}-human`, {
            cwd: "/verification",
        });
        preCleanFixtures(prefix);

        // ------------------------------------------------------------------
        // Case 1: create a new proposal -> status draft, nested provenance
        // stamped by the transport, and a top-level created_by is REFUSED
        // before any work.
        // ------------------------------------------------------------------
        const created = saveSkillProposal(
            proposingSessionID,
            {
                skill_slug: `${prefix}-alpha-skill`,
                skill_name: "Alpha verify skill",
                description: "Verifier fixture skill proposal (alpha).",
                trigger: "When running the skill-proposal verifier.",
                proposed_pack: "verify-pack",
                rationale: "Exercises the intake contract end to end.",
                evidence_refs: ["docs/ai/verify-provenance.md"],
                proposed_skill_content: "# Alpha\nDraft outline only.\n",
            },
            { cwd: "/verification" },
        );
        const alphaID = trackID(created);
        if (!created.created) {
            throw new StateError(
                "Case 1: expected a brand-new proposal to report created:true.",
            );
        }
        if (created.proposal.status !== "draft") {
            throw new StateError(
                `Case 1: expected new proposal status "draft", got "${created.proposal.status}".`,
            );
        }
        if (
            created.proposal.metadata["proposal-origin"] !== "model-session"
        ) {
            throw new StateError(
                `Case 1: expected metadata.proposal-origin "model-session", got "${created.proposal.metadata["proposal-origin"]}".`,
            );
        }
        if (
            created.proposal.metadata.proposing_session_name !==
            `${prefix}-proposer`
        ) {
            throw new StateError(
                `Case 1: expected proposing_session_name to be stamped from the bound session, got "${created.proposal.metadata.proposing_session_name}".`,
            );
        }
        if (
            Object.prototype.hasOwnProperty.call(
                created.proposal,
                "created_by",
            )
        ) {
            throw new StateError(
                "Case 1: proposal payload must NOT carry a top-level created_by field.",
            );
        }
        if (created.proposal.accepted_at || created.proposal.rejected_at) {
            throw new StateError(
                "Case 1: a fresh draft must carry null accepted_at/rejected_at.",
            );
        }
        if (!fs.existsSync(proposalCardPath(alphaID))) {
            throw new StateError(
                "Case 1: the canonical path id must locate the on-disk card.",
            );
        }
        // Pinning the D2 fix: the returned proposal_id MUST be pre-normalized
        // (no capital "T" from planTimestamp) and equal the on-disk filename
        // stem from the moment of creation. Before the fix,
        // generateSkillProposalId returned the raw planTimestamp-bearing id
        // while the filename stem was slug-lowercased, so the two diverged in
        // case on a fresh create. alphaID is the path-derived canonical stem,
        // so equality proves no divergence.
        if (created.proposal.proposal_id !== alphaID) {
            throw new StateError(
                `Case 1: returned proposal_id must equal the normalized filename stem "${alphaID}", got "${created.proposal.proposal_id}".`,
            );
        }
        // Top-level created_by is refused at the write layer (the input is
        // rejected before any file is written).
        expectStateError(
            () =>
                saveSkillProposal(
                    proposingSessionID,
                    {
                        proposal_id: `${prefix}-refused-created-by`,
                        skill_slug: `${prefix}-refused`,
                        skill_name: "Refused created_by",
                        description: "Must be rejected at the write layer.",
                        trigger: "Never — fixture for created_by refusal.",
                        created_by: "model-self",
                    },
                    { cwd: "/verification" },
                ),
            "created_by",
        );

        // ------------------------------------------------------------------
        // Case 2 (B1 REGRESSION): update an existing draft. This MUST NOT
        // throw. Before the fix, saveSkillProposal routed the
        // status-preserving save through skillProposalStatusTransitionErrors,
        // whose current===next branch rejected draft->draft as a non-transition
        // and threw — so every existing-draft update failed. After the fix the
        // save only routes the CREATE case through the validator; the
        // preceding currentStatus !== "draft" guard + draft-only-create rule
        // enforce the invariant without mis-routing preservation saves.
        // ------------------------------------------------------------------
        const updated = saveSkillProposal(
            proposingSessionID,
            {
                proposal_id: alphaID,
                skill_slug: `${prefix}-alpha-skill`,
                skill_name: "Alpha verify skill (revised)",
                description: "Updated description on an existing draft.",
                trigger: "When running the skill-proposal verifier (revised).",
                rationale: "Updated rationale proving the draft-update path.",
                evidence_refs: [
                    "docs/ai/verify-provenance.md",
                    "researches/sources/verify-extra.md",
                ],
            },
            { cwd: "/verification" },
        );
        if (updated.created) {
            throw new StateError(
                "Case 2 (B1): an update to an existing proposal_id must report created:false.",
            );
        }
        if (updated.proposal.status !== "draft") {
            throw new StateError(
                `Case 2 (B1): an existing-draft update must preserve status "draft", got "${updated.proposal.status}".`,
            );
        }
        if (updated.proposal.skill_name !== "Alpha verify skill (revised)") {
            throw new StateError(
                "Case 2 (B1): the updated skill_name must persist on the existing draft.",
            );
        }
        if (
            updated.proposal.description !==
            "Updated description on an existing draft."
        ) {
            throw new StateError(
                "Case 2 (B1): the updated description must persist on the existing draft.",
            );
        }
        if (updated.proposal.evidence_refs.length !== 2) {
            throw new StateError(
                `Case 2 (B1): expected 2 evidence_refs after update, got ${updated.proposal.evidence_refs.length}.`,
            );
        }
        // created_at is preserved across the update; updated_at advances.
        if (updated.proposal.created_at !== created.proposal.created_at) {
            throw new StateError(
                "Case 2 (B1): created_at must be preserved across a draft update.",
            );
        }
        // After the update the stored proposal_id is the canonical (normalized)
        // form; re-derive so the Case 3 list assertion string-equals the form
        // list_skill_proposals returns.
        const alphaListID = canonicalProposalId(updated);

        // ------------------------------------------------------------------
        // Case 3: list and read surface the draft.
        // ------------------------------------------------------------------
        const listed = listSkillProposals(proposingSessionID, {
            cwd: "/verification",
            statuses: ["draft"],
        });
        if (!listed.proposals.some((p) => p.proposal_id === alphaListID)) {
            throw new StateError(
                "Case 3: expected the draft proposal to appear in list_skill_proposals(draft).",
            );
        }
        const draftCount = listed.status_counts.draft || 0;
        if (draftCount < 1) {
            throw new StateError(
                `Case 3: expected at least one draft in status_counts, got ${draftCount}.`,
            );
        }
        const readBack = readSkillProposal(
            proposingSessionID,
            alphaID,
            { cwd: "/verification" },
        );
        if (readBack.proposal.status !== "draft") {
            throw new StateError(
                "Case 3: read_skill_proposal must surface the draft status.",
            );
        }
        if (readBack.summary.status !== "draft") {
            throw new StateError(
                "Case 3: read_skill_proposal summary must surface the draft status.",
            );
        }

        // ------------------------------------------------------------------
        // Case 4: draft -> accepted (the human gate). Acceptance creates NO
        // skill: no SKILL.md is written anywhere under .opencode/skills/.
        // ------------------------------------------------------------------
        const skillsBefore = snapshotSkillFiles();
        const accepted = setSkillProposalStatus(
            humanSessionID,
            alphaID,
            "accepted",
            { cwd: "/verification" },
        );
        if (accepted.proposal.status !== "accepted") {
            throw new StateError(
                `Case 4: expected accepted status, got "${accepted.proposal.status}".`,
            );
        }
        if (!accepted.proposal.accepted_at) {
            throw new StateError(
                "Case 4: accepted transition must stamp accepted_at.",
            );
        }
        if (accepted.proposal.rejected_at) {
            throw new StateError(
                "Case 4: accepted transition must NOT stamp rejected_at.",
            );
        }
        const skillsAfterAccept = snapshotSkillFiles();
        if (
            skillsAfterAccept.size !== skillsBefore.size ||
            [...skillsAfterAccept].some((f) => !skillsBefore.has(f))
        ) {
            throw new StateError(
                "Case 4: acceptance must create NO skill (the .opencode/skills/ SKILL.md set changed).",
            );
        }
        // The accepted card must still be readable and provenance must survive
        // the transition (the transport re-ensures core fields on every write).
        const readAccepted = readSkillProposal(
            proposingSessionID,
            alphaID,
            { cwd: "/verification" },
        );
        if (
            readAccepted.proposal.metadata["proposal-origin"] !== "model-session"
        ) {
            throw new StateError(
                "Case 4: provenance must survive the accepted transition.",
            );
        }

        // ------------------------------------------------------------------
        // Case 5: accepted -> rejected REFUSED (terminal freeze). accepted is
        // closed; the operator who changed their mind opens a NEW proposal.
        // ------------------------------------------------------------------
        expectStateError(
            () =>
                setSkillProposalStatus(
                    humanSessionID,
                    alphaID,
                    "rejected",
                    { cwd: "/verification" },
                ),
            "cannot transition",
        );
        // Also refused: accepted -> accepted (current===next non-transition).
        expectStateError(
            () =>
                setSkillProposalStatus(
                    humanSessionID,
                    alphaID,
                    "accepted",
                    { cwd: "/verification" },
                ),
            "already in status",
        );

        // ------------------------------------------------------------------
        // Case 6: draft -> rejected -> terminal. A fresh draft is rejected
        // (with a reason) and must then refuse any further transition.
        // ------------------------------------------------------------------
        const beta = saveSkillProposal(
            proposingSessionID,
            {
                skill_slug: `${prefix}-beta-skill`,
                skill_name: "Beta verify skill",
                description: "Verifier fixture skill proposal (beta).",
                trigger: "When exercising the reject path.",
            },
            { cwd: "/verification" },
        );
        const betaID = trackID(beta);
        const rejected = setSkillProposalStatus(
            humanSessionID,
            betaID,
            "rejected",
            {
                cwd: "/verification",
                rejectionReason: "Not yet ticket-ready; re-propose later.",
            },
        );
        if (rejected.proposal.status !== "rejected") {
            throw new StateError(
                `Case 6: expected rejected status, got "${rejected.proposal.status}".`,
            );
        }
        if (!rejected.proposal.rejected_at) {
            throw new StateError(
                "Case 6: rejected transition must stamp rejected_at.",
            );
        }
        if (
            rejected.proposal.rejection_reason !==
            "Not yet ticket-ready; re-propose later."
        ) {
            throw new StateError(
                "Case 6: rejection_reason must be recorded on the terminal card.",
            );
        }
        // Re-editing a decided (rejected) card is refused — re-editing would
        // bypass the human gate's finality. The operator opens a NEW proposal.
        expectStateError(
            () =>
                saveSkillProposal(
                    proposingSessionID,
                    {
                        proposal_id: betaID,
                        skill_slug: `${prefix}-beta-skill`,
                        skill_name: "Beta verify skill (resurrect attempt)",
                        description: "Must be refused; rejected is terminal.",
                        trigger: "Never — resurrection fixture.",
                    },
                    { cwd: "/verification" },
                ),
            "terminal status",
        );
        // rejected -> accepted also refused (terminal).
        expectStateError(
            () =>
                setSkillProposalStatus(
                    humanSessionID,
                    betaID,
                    "accepted",
                    { cwd: "/verification" },
                ),
            "cannot transition",
        );

        // ------------------------------------------------------------------
        // Case 7: deleteSkillProposal retires the transport card. The card
        // file is gone; this is destructive hard removal of gitignored
        // transport, NOT a lifecycle status or gate bypass.
        // ------------------------------------------------------------------
        const gamma = saveSkillProposal(
            proposingSessionID,
            {
                skill_slug: `${prefix}-gamma-skill`,
                skill_name: "Gamma verify skill",
                description: "Verifier fixture skill proposal (gamma).",
                trigger: "When exercising the delete path.",
            },
            { cwd: "/verification" },
        );
        const gammaID = trackID(gamma);
        if (!fs.existsSync(proposalCardPath(gammaID))) {
            throw new StateError(
                "Case 7: precondition — gamma card must exist before delete.",
            );
        }
        const removed = deleteSkillProposal(
            proposingSessionID,
            gammaID,
            { cwd: "/verification" },
        );
        if (!removed.ok || removed.operation !== "delete_skill_proposal") {
            throw new StateError(
                "Case 7: expected ok delete_skill_proposal result.",
            );
        }
        if (removed.removed.proposal_id !== gammaID) {
            throw new StateError(
                "Case 7: removed.proposal_id must match the retired card.",
            );
        }
        if (!removed.removed.card_removed) {
            throw new StateError(
                "Case 7: expected card_removed:true after delete.",
            );
        }
        if (fs.existsSync(proposalCardPath(gammaID))) {
            throw new StateError(
                "Case 7: card JSON must be gone after delete.",
            );
        }
        // delete is NOT a lifecycle decision: a missing card simply reports
        // card_removed:false (idempotent retire), it does not throw.
        const removedAgain = deleteSkillProposal(
            proposingSessionID,
            gammaID,
            { cwd: "/verification" },
        );
        if (!removedAgain.ok || removedAgain.removed.card_removed) {
            throw new StateError(
                "Case 7: re-deleting a missing card must report ok with card_removed:false.",
            );
        }
        // Single-ID safety: wildcards/path-like/comma input are refused.
        for (const invalid of ["*", "a,b", "../escape", "foo/bar", "a b"]) {
            expectStateError(
                () =>
                    deleteSkillProposal(proposingSessionID, invalid, {
                        cwd: "/verification",
                    }),
                "delete_skill_proposal",
            );
        }

        // ------------------------------------------------------------------
        // Case 8: provenance is stamped by the TRANSPORT from the real
        // session, not trusted from the caller. A forged
        // metadata.proposal-origin and forged proposing_session_name are
        // overwritten/ignored; the transport owns these fields. (A top-level
        // created_by is a separate REFUSAL — covered in Case 1 — not an
        // overwrite, so it is not supplied here.)
        // ------------------------------------------------------------------
        const forged = saveSkillProposal(
            proposingSessionID,
            {
                skill_slug: `${prefix}-forged-skill`,
                skill_name: "Forged provenance sentinel",
                description: "Attempts to forge authority-adjacent provenance.",
                trigger: "Never — provenance forgery fixture.",
                // Caller-attempted forgeries (all must be ignored/overwritten):
                metadata: {
                    "proposal-origin": "human-operator",
                    proposing_session_name: "forged-human-alias",
                    proposing_session_id: "forged-session-id",
                },
            },
            { cwd: "/verification" },
        );
        const forgedID = trackID(forged);
        if (
            forged.proposal.metadata["proposal-origin"] !== "model-session"
        ) {
            throw new StateError(
                `Case 8: forged proposal-origin must be overwritten to "model-session", got "${forged.proposal.metadata["proposal-origin"]}".`,
            );
        }
        if (
            forged.proposal.metadata.proposing_session_name !==
            `${prefix}-proposer`
        ) {
            throw new StateError(
                `Case 8: forged proposing_session_name must be overwritten from the real bound session, got "${forged.proposal.metadata.proposing_session_name}".`,
            );
        }
        if (
            forged.proposal.metadata.proposing_session_id ===
            "forged-session-id"
        ) {
            throw new StateError(
                "Case 8: forged proposing_session_id must NOT survive (transport owns it).",
            );
        }
        void forgedID;

        console.log("verification: ok");
        console.log(`alpha_proposal_id: ${alphaID}`);
        console.log(`beta_proposal_id: ${betaID}`);
        console.log(`forged_proposal_id: ${forgedID}`);
        console.log(`accepted_at: ${accepted.proposal.accepted_at}`);
        console.log(`rejected_at: ${rejected.proposal.rejected_at}`);
    } finally {
        cleanupArtifacts(createdProposalIDs);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
