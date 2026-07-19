---
name: media-perception
description: "Caller-facing routing aid for media-perception in vh-solara — decide between in-context perception (vision-capable caller) and single-delegation to the media-perception specialist (text-only caller or heavy/multi-step perception). Load this skill when you hold an image, diagram, chart, video, document/PDF, or audio locator and need to decide how to perceive it."
compatibility: opencode
---

# Media Perception Routing

> **Two paths.** When you (the caller) can already see the media in-context
> and have a vision-capable model, perceive it yourself — zero round-trips,
> iterate freely. Otherwise delegate ONCE to the `media-perception`
> specialist with a path/URL locator and the full question set; expect a
> single consolidated report.

This skill is for callers (`build`, `researcher`, `coordination`,
`project-coordinator`) that find themselves holding a media artifact and need
to decide how to perceive it. It does not run perception itself — it routes.

## When to load

Load this skill when:

- a user or upstream handoff gave you a media locator (`path:` or `url:`) and
  a question about what the media shows or contains
- you are about to say “I can’t see images” or “I have no vision capability”
  — STOP and load this skill instead
- you are deciding whether to delegate perception or handle it inline
- you received a perception report from `media-perception` and need to
  interpret `capability_status`

## Capability-class vocabulary

Reason and route in terms of CAPABILITY CLASSES, not vendor or tool names:

- image interpretation / OCR
- diagram understanding
- chart / data-visualization analysis
- video / frame analysis
- document-page interpretation (PDF and similar paginated docs)
- audio transcription / analysis

Do not name specific tools, packages, providers, or install commands in your
routing decision or your handoff. If you only see a concrete tool name in the
session, route by its capability class.

## Path A — in-context perception

Use Path A when ALL of:

- your own model is vision-capable for the modality in question, AND
- the runtime has actually made the media inspectable to you (the image is
  visible in your context, the audio is playable, the PDF page rendered), AND
  - the perception work is light enough to iterate inline

Path A is zero round-trips: you perceive directly, ask follow-ups, and
answer. Do NOT delegate to `media-perception` from Path A — that adds a
round-trip for no benefit.

## Path B — single delegation to `media-perception`

Use Path B when ANY of:

- your model is text-only or lacks the modality in question
- the media is NOT in your context (you only have a path or URL)
- the perception is heavy or multi-step (many figures, long video, large
  paginated doc) and a dedicated specialist is cheaper
- you find yourself about to refuse a perception task

### Handoff contract

Delegate ONCE with:

- a **locator** the specialist can reach: `path: <repo-relative or accessible
  path>` or `url: <accessible URL>`
- a **modality hint** (image | diagram | chart | video | document | audio |
  unknown) when known
- the **full question set** the perception must answer — do not hold back
  questions for later round-trips

Do not assume attachments auto-propagate into the specialist’s context. Pass
the locator explicitly.

### What to expect back

One consolidated report from `media-perception`:

```
capability_status: available | unavailable | uncertain
input:        { locator, modality_hint }
basis:        native | tool | none | uncertain
tools_used:   [capability-class descriptions, or "none"]
observations: [ grounded observations ]
limitations:  [ what could not be determined, and why ]
next_action:  [ one concrete next step for the caller ]
```

Treat this as a complete answer. Do not re-delegate for the same question
set; if you need more, follow `next_action` (different locator, different
modality hint, expose a missing capability class) — not a re-run.

## Handling `capability_status`

- `available` — observations are grounded in a successful capability
  invocation. Proceed on their strength, respecting `limitations`.
- `unavailable` — no compatible capability is exposed in the session. This
  is a normal, expected outcome for sessions that have not wired a perception
  capability. Surface it honestly to your caller; do not paper over it with
  speculation about what the media might contain. The fix is environmental
  (expose a compatible capability via overlay or operator config), not a
  retry.
- `uncertain` — capability presence or media access could not be established.
  Follow `next_action`; usually a clearer locator or a different modality
  hint.

Never fabricate observations to fill a `unavailable` or `uncertain` gap. Say
the gap plainly.

## When NOT to delegate

- You do not have a path or URL, only a vague mention of media — get a
  locator first.
- The task is about generating media (drawing, rendering, transcribing into a
  file), not perceiving existing media — `media-perception` is read-only and
  does not produce media.
- The “perception” is trivially answerable from surrounding text (a caption,
  an alt-text, a transcript already in scope) — read that first.

## Adding project-specific modality specialists (overlay recipe)

This core capability ships a single perception generalist. A consuming
project that needs dedicated per-modality specialists (image-only, video-only,
audio-only, etc.) can add them via an overlay pack under
`.vh-agent-harness/overlays/<pack>/`:

1. Add the specialist agent file under `agents/` in the pack.
2. Declare its task edges (leaf-shaped: deny-all, with inbound edges from the
   same caller set or a narrower one) in the pack’s `permission-pack.jsonc`.
3. Wire its model reference and any capability gate in
   `opencode-append.jsonc`.
4. List the pack under `overlays:` in `.vh-agent-harness/vh-harness-profile.yml`.

The exact core-side splicing seam for replacing the generalist with a cluster
is not part of this skill’s contract — the overlay path above is the
supported way to add specialists without modifying core.
