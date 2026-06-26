# compaction-primitives.project.example.md (OVERLAY)

This note documents a project-specific block that the generic
`compaction-primitives.js` deliberately OMITS, so a consuming project can
re-add it via its own overlay / local config.

## What was removed

The source harness's `compaction-primitives.js` carried a **demo-API-credentials
compaction block** that, during compaction, would preserve a set of
`<BRAND>_DEMO_*` environment-variable references (account, password, API base,
JWT secret) and the `.env.local` sourcing pattern used to drive the demo VPS API
end-to-end. Those literals are project-specific (demo infra, project JWT secret
name, project env-var prefix), so the generic template removes them.

## How to re-add it in your project

If your project drives a demo/integration API the same way, add a project
overlay block to your local `compaction-primitives` config (or a project
overlay file that the plugin loads after the generic one) preserving:

- `VH-SOLARA_DEMO_ACCOUNT`
- `VH-SOLARA_DEMO_PASSWORD`
- `VH-SOLARA_DEMO_API_BASE`
- `VH-SOLARA_JWT_SECRET` (never echo or paste on a command line —
  shell-guard denies it; log in via the auth endpoint to mint a token instead)
- the `.env.local` sourcing pattern

## Why it lives in the overlay, not the core

Compaction primitives that reference a specific project's env-var names and a
specific demo host are `overlay` ownership class: the project supplies its own
instance. The generic plugin keeps only brand-free, project-agnostic compaction
guarantees.
