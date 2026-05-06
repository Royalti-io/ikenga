# Ikenga migration · prompt for a fresh Claude session

Copy-paste the block below into a fresh `claude` session in `ikenga-desktop/`. It carries enough context that the agent can execute without re-discovering the system.

---

## Prompt

I want you to migrate one of the off-palette routes in `ikenga-desktop` to use the Ikenga design system natively. Pick **one** route per session — don't try to do them all.

### Context you need to read first

1. `ikenga-desktop/CLAUDE.md` — repo conventions (bun, TanStack Router, Tauri, biome, route generation rules)
2. `ikenga-desktop/docs/ikenga-migration-status.md` — current state, conventions, color cheat-sheet, and the ranked off-palette punch-list
3. `ikenga-desktop/src/lib/ikenga/tokens.css` — the only color/spacing/font source of truth
4. `ikenga-desktop/src/styles.css` — the `@theme` block that maps Ikenga vars to Tailwind/shadcn aliases (so `bg-card`, `border`, `text-muted-foreground` already work; `bg-amber-100`, `text-sky-700` etc. do *not* and must go)
5. `ikenga-desktop/src/routes/tasks/tasks.css` and `ikenga-desktop/src/routes/outbox/outbox.css` — reference implementations. Tasks uses `.tk-*`; outbox uses `.ob-*`. Mirror the approach.
6. The matching design-concept HTML in `ikenga-desktop/design/concepts/03-screens/` if one exists for the route you pick (e.g. screen 01 for inbox, screen 05 for finance, screen 08 for tasks).

### What "migrated" means

A route is migrated when:

1. It has its own `<route>/<route>.css` that references only Ikenga vars (`--bg-surface`, `--fg`, `--tint-fg-active`, `--achievement`, `--danger`, etc.)
2. The route uses a unique class prefix (e.g. `.fn-` for finance, `.ml-` for mail)
3. **No** literal Tailwind color classes remain (`bg-amber-100`, `text-sky-700`, `bg-green-600`, `text-red-700`, `bg-rose-50`, etc.) The aliased ones (`bg-card`, `text-muted-foreground`, `border-border`, `bg-background`) are fine since they resolve via `@theme`.
4. `data-workspace` tinting works — the active workspace's `--tint-fg-active` is used for the primary action color so the screen visually belongs to its workspace.
5. Workspace tint is applied via `linear-gradient(180deg, var(--tint-bg-active, var(--bg-surface)) 0%, var(--bg-surface) 100%)` on the section header — see `outbox.css` `.ob-header` for the pattern.
6. Status / state colors come from semantic tokens (`--achievement` for success/sent, `--danger` for overdue/destructive, `--systemic` for neutral system status), not literal palette names.
7. `bun run typecheck` passes (one pre-existing unrelated error in `settings/index.tsx` is fine — leave it).
8. `bun run tsr:generate` runs cleanly (don't add files inside `src/routes/` that aren't routes; for support components use a `-components/` directory — the `-` prefix tells TanStack Router to ignore it).

### Conventions

- `bun` only (no npm/pnpm)
- Per-screen CSS file imported at the top of the route's `route.tsx` so it loads when the route mounts
- shadcn primitives (Button, Dialog, etc.) stay — they already use `data-slot` hooks that resolve to Ikenga vars via `src/styles.css`
- Don't refactor the data layer (TanStack Query, Supabase calls). Visual layer only unless the data model is actively wrong.
- Don't add comments explaining what well-named CSS classes do. Only add a comment if WHY is non-obvious (e.g. "tint-bg-active resolves per-workspace via [data-workspace] on <html>").
- Don't run `git reset` or modify `.env*`.

### Where to start

Read `docs/ikenga-migration-status.md` first. The "Off-palette / Aliased — needs migration" section ranks routes by severity. **High-severity routes**:

- `mail/*` — inbox is the most-touched screen; design Screen 01 has the spec
- `finance/*` — design Screen 05 exists; multi-currency badges are the most visible offender
- `triage/*` — shares patterns with inbox; pick this if you do mail, since they cross-reference

Pick ONE. Confirm your pick with the user before writing code, and ask them whether to grep-survey the file's current state first or just open it and start.

### What to deliver

1. New `<route>/<route>.css`
2. Refactored `route.tsx` and any sub-pages within that route
3. Type-check green
4. A one-paragraph update to `docs/ikenga-migration-status.md` flipping that route from "needs migration" to "Native" and noting any follow-ups (e.g. "detail view still needs the chip-variant pass")

### What NOT to do

- Don't migrate more than one route per session — context grows fast and the diff becomes unreviewable
- Don't add new tokens to `tokens.css`. If you think you need a new token, surface that as a design-decision question, not a code change
- Don't rewrite the data fetching even if it looks improvable — out of scope
- Don't introduce framer-motion, react-spring, or any new animation library — Ikenga uses CSS transitions with `--motion-*` and `--ease-*` tokens
- Don't write test files unless asked

Begin by reading the migration-status doc and asking which route I want migrated.

---

## Notes for the human (not part of the prompt)

- Keep the migration sessions short (one route at a time) — the diffs stay reviewable that way
- After each migration, update `ikenga-migration-status.md` so the next session knows what's left
- If a route has a corresponding design concept (Screen NN), open that HTML in the prompt context — the agent will mirror it 1:1 if it can see it
- The keyboard hook at `src/routes/outbox/-components/use-outbox-keyboard.ts` is reusable — point migrators at it if their route has a list with prev/next semantics
