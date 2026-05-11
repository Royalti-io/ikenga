# Phase 1 — Onboarding Wizard Design Approval

**Date:** 2026-05-11
**Reviewer:** Ned (chinedum@royalti.io)
**Coordinator:** Phase 0 main session

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Chrome variant** | **A — edge-to-edge full-window** | Most native to Tauri 1280×800; top progress bar doubles as stepper; sidebar hidden during onboarding. Becomes canonical for Phase 3's stepper component. |
| **Theme / brand** | Dusk Wood · Light · Plus Jakarta Sans | Warm cream + oxblood-clay; no gold (Q2 2026 brand), no purple-blue gradient, no AI-sparkle. |
| **Telemetry ship-default** | **OFF** | Privacy-first. User must opt in. |
| **Engine pkg in offline-mode** | **Skip engine pkg auto-install; ship engine-noop only** | User can install Claude Code engine pkg later from Packages. Matches the "designed for plug-in adapters" philosophy. |
| **Connector secrets** | Stronghold vault (URLs/usernames metadata only in SQLite) | Matches existing secret discipline. |
| **Step 6 scaffolding conflict** | Merge (default) / Skip / Overwrite-with-backup | Three modes captured in state variant. |
| **Summary "Edit" links** | Re-open prior steps INSIDE the wizard | Corrections feel like wizard work, not post-setup admin. |

## Requested deltas

None. Approved as-is.

## Artifact inventory

- **Prototypes:** 21 HTML files in `../prototypes/` (9 step files + 4 state variants + 6 chrome variant exemplars + shared base.css)
- **Screenshots:** 21 PNGs in `../screenshots/` (full nine in Variant A + A/B/C compare on Welcome + Summary + 1440×900 mac framing)
- **Spec:** `wizard-spec.md` (504 lines)

## Downstream dispatch

Approval unblocks:

- **Phase 2** (detect-agent) — `feat/onboarding-wizard` on `ikenga/shell/`
- **Phase 7** (engine-delta-agent) — `feat/onboarding-engine-delta` on `ikenga/contract/`

Both dispatched in parallel by the coordinator immediately after this file is written.

## Open questions answered

1. **Chrome variant choice** → Variant A locked.
2. **Telemetry default** → OFF.
3. **Engine pkg behaviour in offline mode** → Skip auto-install; engine-noop only.
