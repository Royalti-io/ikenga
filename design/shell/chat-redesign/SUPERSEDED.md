# ⚠️ SUPERSEDED — Chat Redesign Artifacts

**Date retired:** 2026-08-08
**Superseded by:** [ADR-019](file:///home/nedjamez/royalti-co/ikenga/docs/adr/019-chi-first-agent-surface.md) · [plans/2026-08-08-ikenga-chi-first](file:///home/nedjamez/royalti-co/ikenga/plans/2026-08-08-ikenga-chi-first/)

The shell chat surface (`src/chat/`, `src/routes/sessions/`, `chat_sessions` table) was removed in full as part of the **Chi-first agent surface** decision. The replacement is:

- **`iyke chi`** CLI — `iyke chi run / resume / status / list / cancel`
- **MCP tools** — `iyke_chi_run`, `iyke_chi_status`, `iyke_chi_list`, `iyke_chi_cancel`, `iyke_chi_resume` (in `packages/mcp/iyke/`)

These artifacts are kept for historical reference only. Do not implement or build on them.
