# Ikenga First-Run Onboarding Wizard — Spec

> Phase 1 design contract. Defines what each step does, where its choices land,
> how it's re-entered from Settings, and the persistence shape Phase 3 implements.
>
> **Status**: design-locked pending user review (see prototypes/, screenshots/, and
> the still-absent specs/APPROVAL.md). No code in `shell/src/` or any sibling pkg yet.

---

## 0. Trigger & top-level rules

- **When it runs.** First boot, detected by absence of a sentinel
  `~/.ikenga/onboarding.complete` file written at end of Step 9.
- **Window.** Tauri default desktop 1280×800 (mac variant 1440×900). The wizard
  occupies the full window — no native menu, no activity bar — until Step 9
  fires `open-workspace`.
- **Theme/mode at wizard time.** Defaults to Theme A · Light · Comfortable
  density until Step 7 commits a user choice. Tokens come from
  `@ikenga/tokens/tokens.css`.
- **Persistence backbone.** A single `OnboardingState` object (see §10)
  serialized to SQLite via a new `0007_onboarding` migration. Every step
  writes its slice on **Continue / Save**; **Back** never destroys a slice.
  Closing the window mid-wizard resumes from the last-completed step on
  next boot.
- **Stronghold vs SQLite.** Secrets (API keys, tokens, passwords) land in
  Stronghold, addressed by stable handles. SQLite stores only the handle
  string + metadata.
- **Skip vs Back.**
  - **Back** revisits the previous step with its slice intact.
  - **Skip** marks the step as `skipped: true` and advances. The Summary
    flags skipped steps with a muted card + reminder copy. Settings shows
    a "Resume setup" entry while any step is skipped.

---

## 1. Step 1 — Welcome / System preflight

**Purpose.** Establish trust and confirm the host machine can run Ikenga.
Surface a one-shot landing surface that explains the next ~4 minutes.

**Display only — no inputs.** Five preflight checks rendered as a list:

| Check               | Pass criterion                                       | Failure handling                                |
|---------------------|------------------------------------------------------|-------------------------------------------------|
| Operating system    | macOS ≥ 13 · Windows ≥ 11 · Linux x64/arm64          | Hard block: Continue disabled, link to docs     |
| Disk space          | ≥ 2 GB free on the volume holding `~/.ikenga`        | Hard block                                       |
| Stronghold vault    | Creates `~/.ikenga/vault.stronghold` (passphrase-derived from machine keychain) | Hard block: surface OS-specific error |
| Tauri capabilities  | `fs`, `shell`, `http`, `notifications` all granted    | Soft warn: show which one and a re-grant button  |
| Network             | DNS resolves `registry.ikenga.ai`                     | Soft warn (VPN/offline still allowed)            |

**Write-target.** None on Continue. Preflight findings cached in memory only
(re-runs cheaply if the user closes/reopens the wizard).

**Navigation.** Back disabled. Continue requires all hard checks green.
Skip-setup escape hatch in the footer for users who want to abandon entirely
(stamps `~/.ikenga/onboarding.skipped`, opens an empty workspace; Settings
shows "Resume setup").

**Settings re-entry.** `Settings → About → Re-run preflight`.

---

## 2. Step 2 — Coding agent

**Purpose.** Detect which agent(s) are on the user's machine, let them pick
one as the primary engine driving the shell, and offer an offline-only mode.

**Detection (runs on step mount).** Scan `$PATH`, `~/.bun/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`, and common asdf/mise shims for:
`claude` (Claude Code), `codex` (Codex CLI), `gemini` (Gemini CLI),
`cursor` (Cursor CLI), `aider`. For each: version, binary path, auth status,
known capabilities. Detection time should fit in <1 s.

**Fields (per agent card, all read-only except the radio).**

- Selection radio (one primary).
- Multi-select checkboxes for secondary agents — wizard picks "additional
  engines I want to be able to switch to from the engine menu".
- "Add an agent" tile opens a path-picker → wraps it in a stub
  `@ikenga/contract` Engine adapter and registers it in the agent registry.
- "Continue offline" escape button → sets `agent.primary = null`,
  `agent.offlineMode = true`.

**Validation.** Either `agent.primary` is set, or `agent.offlineMode === true`.

**Write-target.**
- SQLite `onboarding_state.agent.*`.
- Stronghold: nothing here — agent credentials are managed by the CLIs
  themselves. We only record the binary path + version.

**Navigation.** Back to Step 1. Continue requires validation pass. No skip
(but offline mode satisfies the requirement).

**Settings re-entry.** `Settings → Engine`.

**State variant covered.** `02-coding-agent-empty.html` — zero detected
agents → installation hint list + offline continue button.

---

## 3. Step 3 — Project & file roots

**Purpose.** Tell Ikenga which folders matter so terminal `cwd`s, file pane
roots, and project routing have somewhere to start.

**Detection.** Scan a curated set of likely parents (`~/Code`, `~/Projects`,
`~/Documents`, `~/royalti-co` if present, `~/git`) for folders that look like
projects: presence of `package.json`, `pnpm-workspace.yaml`, `Cargo.toml`,
`.git`, or `pyproject.toml`. Limit to depth 2. Sort by last-touched.

**Fields.**

- Detected list — each row is a checkbox + path + meta + workspace-tag
  badge (`code`, `notes`, `media`, `archive`). One row may be marked
  `primary` (the default cwd for new terminals & the target for Step 6
  scaffolding).
- Custom path: free-form input + native browse button.
- `~/.claude/projects/` import: if the directory exists with recent
  sessions, offer to bulk-add those project paths.

**Validation.** At least one root selected. Exactly one `primary`.

**Write-target.** SQLite `onboarding_state.roots[]` and
`onboarding_state.primaryRoot`. After Continue: kicks off a deferred
background lazy-index (does **not** block the wizard).

**Navigation.** Back/Continue. Skip not allowed (a workspace without roots
is meaningless).

**Settings re-entry.** `Settings → Workspace → Roots`.

---

## 4. Step 4 — App packages

**Purpose.** Pick which UI pkgs ship with the workspace. Each pkg is a
self-contained mini-app (`pkgs/<name>/`) with its own update channel.

**Catalog source.** Pulled from the static registry at
`https://registry.ikenga.ai/index.json` at step mount, with a 3-second
network timeout; falls back to the in-shell bundled registry if offline.

**Fields.**

- Filter pills: All · Local-only · Needs cloud · Engine pkgs.
- Each card has a multi-select on/off toggle. Engine pkg(s) are required
  (no toggle) unless Step 2 picked offline mode.
- "What this needs" badges (per card) drive Step 5 substep generation:
  `capabilities.supabase` → Supabase substep, `capabilities.resend` →
  Resend substep, etc. (Schema in §9.)

**Validation.** At least one engine pkg selected (or offline mode).

**Write-target.** SQLite `onboarding_state.packages[]` — array of `{name,
version, channel}` tuples. After Continue: enqueue downloads to the
package kernel; downloads run in the background and don't block Step 5+.

**Navigation.** Back/Continue.

**Settings re-entry.** `Settings → Packages`.

**State variant covered.** `04-packages-cloud-disabled.html` — when Step 5
is fully skipped, cloud-required cards grey out with a per-card reason
strip.

---

## 5. Step 5 — Connector setup (dynamic substeps)

**Purpose.** Capture credentials for the cloud services that selected pkgs
declared. The set of substeps is computed from the union of
`capabilities.*` flags across the pkgs chosen in Step 4. If no pkg needs a
connector, **this step is skipped entirely** (no banner, no breadcrumb).

**Substep mapping** (also enumerated in §9).

| Capability flag       | Substep            | Required fields                                          |
|-----------------------|--------------------|----------------------------------------------------------|
| `supabase`            | Supabase           | url, anonKey, (optional) serviceRoleKey                  |
| `resend`              | Resend             | apiKey, default sender, verified-domain selection        |
| `listmonk`            | Listmonk           | instanceUrl, adminUsername, apiPassword, default list    |
| `stripe`              | Stripe             | publishableKey, secretKey, webhook signing secret        |
| `payload`             | Payload CMS        | apiUrl, apiKey                                            |
| `imap` / `jmap`       | Mail account       | host, port, username, password, encryption mode          |

**Per-substep UI** (canonical pattern — see prototypes 05-connectors-*.html).

- Left rail: full substep list with active/done/pending state.
- Right pane: form + a who-needs-this pill row showing which pkgs depend
  on this connector + a verify-connection test strip with success/error
  states (live re-test button).
- Footer: Back · Skip-this-substep · Save-and-next.

**Validation.** Each substep validates on **Save** (calls connector-specific
ping). Failures show inline error strips (see
`05-connectors-listmonk.html` for the canonical 401 case). Substep can
always be skipped; doing so leaves the dependent pkgs un-bootable but
installed — Settings shows a reminder.

**Write-target.**
- Stronghold: every secret field, keyed by stable handle
  `connector:<name>:<field>`.
- SQLite `onboarding_state.connectors[]`: `{name, configured, skipped,
  metadata}` — non-secret metadata only (URLs, domain lists, usernames).

**Navigation.** Back from the first substep returns to Step 4. Back inside
the step navigates substep-by-substep. After the last substep,
Continue advances to Step 6.

**Settings re-entry.** `Settings → Connectors` — each connector card has
status, last-verified timestamp, edit/disconnect.

---

## 6. Step 6 — Agent config scaffolding (optional)

**Purpose.** Offer to write a starter set of skills/agents/commands into the
primary root's `.claude/`. Only shown when (a) the primary engine selected
in Step 2 is Claude Code, and (b) the user has selected a primary root in
Step 3. Otherwise the wizard auto-skips this step (records as
`autoSkipped`, not `skipped`).

**Driven by `create-music-workspace`** (in `ikenga/cc-config/`). The same
scaffold ships standalone, so this step is just a pre-bundled invocation.

**Fields.**

- Target path display (read-only): `<primaryRoot>/.claude/`.
- Existing-dir badge: empty / has-files (drives the existing-claude-dir
  variant prototype).
- Preset radio: Music label starter · Generic dev · Solo songwriter ·
  Empty .claude/.
- Preview tree (read-only) showing which files will be written.

**Conflict handling** (state variant
`06-scaffolding-existing-claude-dir.html`). If target `.claude/` exists
with files, surface a modal with three options:

1. **Merge** — additive only; conflicting files written as
   `<name>.ikenga.new` for manual diff/merge. **Default.**
2. **Skip** — no writes.
3. **Overwrite with backup** — rename existing → `.claude.bak-<date>`,
   scaffold fresh.

**Validation.** No required input — a preset must be picked or the step
must be skipped.

**Write-target.**
- Filesystem: writes inside `<primaryRoot>/.claude/`. Tag a git commit
  if the root is a git repo (`ikenga scaffold v<n>`).
- SQLite `onboarding_state.scaffolding`: `{preset, conflictMode, fileCount,
  rollbackTag}`.

**Navigation.** Back/Skip/Continue. Skip is first-class here (most users on
a configured machine will skip).

**Settings re-entry.** `Settings → Agents → Scaffolding`; also exposed
through the standalone CLI `ikenga scaffold` for re-runs.

---

## 7. Step 7 — Appearance

**Purpose.** Pick theme, mode, and density. Choices apply **live** so the
user sees the result immediately on the same screen.

**Fields.**

- **Theme**: Dusk Wood (A · default) · Kola Daylight (B) · Bronze Shrine (C).
  Each preview card paints actual token swatches from
  `[data-theme=X][data-mode=Y]`.
- **Mode**: Light (default) · Dark · System.
- **Density**: Compact · Comfortable (default) · Spacious.

Each field defaults to the Q2-2026 brand decision. No gold accent. No
purple-blue gradient. Plus Jakarta Sans only.

**Validation.** None — three picks, all have defaults.

**Write-target.** SQLite `onboarding_state.appearance` AND immediate apply
to the live shell via `:root[data-theme][data-mode]` attribute updates so
Step 8 onwards renders in the chosen palette.

**Navigation.** Back/Continue. No skip (defaults are always valid).

**Settings re-entry.** `Settings → Appearance`.

---

## 8. Step 8 — Telemetry & privacy

**Purpose.** A single opt-in toggle for anonymous detection + crash stats.
Maximally legible "what we do / don't send" comparison.

**Fields.**

- One toggle: `telemetry.enabled` — default **off** (privacy-first).
  Auto mode for Phase 1 prototype shows ON to demonstrate the affordance,
  but Phase 3 implementation must ship default-off.
- Read-only two-column "We send / We never send" table (copy locked here).

**Validation.** None — the toggle has both valid states.

**Write-target.** SQLite `onboarding_state.telemetry.enabled` +
`telemetry.installId` (UUID v4, regenerable). On enable: schedule the
daily batch sender.

**Navigation.** Back/Continue. No skip.

**Settings re-entry.** `Settings → Privacy`.

---

## 9. Step 9 — Summary

**Purpose.** Recap every prior choice in a single scannable grid, surface
deep-links to the Settings page for each choice (so the user knows
nothing is locked in), and provide the Open-Workspace CTA.

**Fields.** Read-only summary cards in a 3-column grid: Coding agent,
Project roots, Packages, each connector (one card per substep, skipped
ones rendered greyed with a one-liner consequence), Scaffolding,
Appearance, Telemetry.

**Each card** carries an `Edit` link that re-opens that step **inside the
wizard window** (not Settings) so corrections feel like wizard work, not
post-setup admin. Cancel from a re-opened step returns to Summary without
clobbering downstream slices.

**Background install strip.** Shows live progress of pkg downloads kicked
off in Step 4. Open Workspace is enabled the moment the engine pkg is
installed; other downloads continue in the background after the workspace
opens.

**Write-target on Open Workspace.**

1. Write `~/.ikenga/onboarding.complete` sentinel (ISO timestamp).
2. Flush `onboarding_state` to SQLite (final write).
3. Emit `open-workspace` Tauri event → the route layer routes the user to
   the activity-bar's default landing pane.

**Navigation.** Back to Step 8. No skip (this is the terminus). A "Start
over" link in the kebab gives the dev/user the option to nuke
`onboarding_state` and run again from Step 1.

**Settings re-entry.** Not applicable — Summary is the terminus. A
condensed read-only version lives at `Settings → Setup history`.

---

## 9.5. Connector substep declaration schema

This is the contract between a pkg's manifest and the wizard's dynamic
substep generation. The schema lives in `@ikenga/contract` (already exists
for `capabilities` — extend it).

```ts
// @ikenga/contract — onboarding portion (sketch)
export type ConnectorCapability =
  | 'supabase'
  | 'resend'
  | 'listmonk'
  | 'stripe'
  | 'payload'
  | 'imap'
  | 'jmap';

export interface PkgManifestOnboarding {
  /** Connectors this pkg needs to function at all. Drives Step 5 substep generation. */
  requires?: ConnectorCapability[];
  /** Connectors that improve the pkg but aren't required. Surfaces as a soft hint, not a substep. */
  optional?: ConnectorCapability[];
}
```

The wizard computes the Step 5 substep set as:

```
substeps = uniq(flatMap(selectedPackages, p => p.onboarding.requires ?? []))
```

Order is fixed by the canonical list in §5 (Supabase first, etc.), not by
pkg discovery order. If `substeps.length === 0`, Step 5 is skipped
entirely (no breadcrumb, no banner).

---

## 10. `OnboardingState` interface (Phase 3 implements)

This is a sketch — Phase 3 finalizes field types, nullability, defaults.

```ts
// shell/src/lib/onboarding/types.ts (to be created in Phase 3)

export interface OnboardingState {
  schemaVersion: 1;
  startedAt: string;       // ISO
  completedAt?: string;    // ISO; set by Step 9
  currentStep: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  skipped: number[];       // step indices the user explicitly skipped

  // Step 1 — preflight is ephemeral, not persisted.

  // Step 2
  agent: {
    primary: string | null;          // 'claude-code' | 'codex' | 'gemini' | <custom-id> | null
    secondary: string[];
    offlineMode: boolean;
    detected: Array<{                // snapshot at detection time
      id: string;
      name: string;
      version: string;
      binaryPath: string;
      authStatus: 'signed-in' | 'api-key' | 'none';
    }>;
  };

  // Step 3
  roots: Array<{
    path: string;                    // absolute
    tag: 'code' | 'notes' | 'media' | 'archive' | 'custom';
    source: 'detected' | 'custom' | 'claude-import';
  }>;
  primaryRoot: string;               // absolute, must appear in roots[]

  // Step 4
  packages: Array<{
    name: string;                    // '@ikenga/pkg-studio'
    version: string;
    channel: 'stable' | 'beta' | 'edge';
  }>;

  // Step 5 — keys live in Stronghold; only metadata here
  connectors: Array<{
    name: ConnectorCapability;
    configured: boolean;
    skipped: boolean;
    metadata: Record<string, string | string[]>;  // URLs, domains, usernames
    strongholdHandles: string[];                  // 'connector:supabase:anonKey', ...
    lastVerifiedAt?: string;
  }>;

  // Step 6
  scaffolding?: {
    preset: 'music-label' | 'generic-dev' | 'solo-songwriter' | 'empty';
    targetPath: string;
    conflictMode: 'merge' | 'overwrite' | 'skipped';
    fileCount: number;
    rollbackTag?: string;            // git tag if root is a repo
  };

  // Step 7
  appearance: {
    theme: 'A' | 'B' | 'C';          // Dusk Wood | Kola Daylight | Bronze Shrine
    mode: 'light' | 'dark' | 'system';
    density: 'compact' | 'comfortable' | 'spacious';
  };

  // Step 8
  telemetry: {
    enabled: boolean;
    installId: string;               // UUID v4
  };
}
```

**Persistence.** Phase 3 should store this as a single JSON blob in a
SQLite row (table `onboarding_state`, single-row pattern keyed by
`id = 1`) added via migration `0007_onboarding`. Stronghold handles
remain stable across re-runs — re-editing a connector overwrites the
Stronghold entry but keeps the handle string.

---

## 11. Things deliberately out of scope for Phase 1

These belong to later phases, not the wizard design:

- **Account/identity** — Ikenga is local-first; there is no user account
  to sign in to at first run.
- **Multi-machine sync** — onboarding state is per-machine. No iCloud /
  Dropbox sync path for it.
- **Workspace seeding** — initial sample content (a demo project, sample
  release, etc.) is a Phase 6+ "Tour" decision, not part of the wizard.
- **Update channel selection** — every pkg has its own channel; the
  wizard always uses `stable`. Settings can switch later.

---

## 12. Open questions for user review

1. **Telemetry default.** Prototype shows ON to demonstrate the affordance,
   but ship-default should be OFF per privacy posture. Confirm?
2. **Engine pkg required vs optional in offline mode.** Currently treated
   as required. Is offline mode meant to skip engine pkg download
   entirely, or download the adapter binary anyway so the user can flip
   to online later without re-running setup? (Recommend: download.)
3. **Chrome variant choice.** A/B/C are designed to be functionally
   equivalent; pick one for Phase 3 to implement. Default
   recommendation: **A** (edge-to-edge) — most native-feeling on Tauri,
   no modal-vs-window ambiguity, fully exploits the 1280×800 canvas, and
   the progress bar at the top doubles as visual stepper without the
   sidebar cost of variant C.
