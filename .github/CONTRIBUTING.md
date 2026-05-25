# Contributing to Ikenga

Thanks for considering a contribution. Ikenga is open source under Apache-2.0, and it's built in the open — issues, pull requests, and discussion all happen on GitHub. This guide covers how to get a working environment, how to file good issues, and how we review changes.

If anything here is unclear or out of date, that's a bug too. Open an issue.

## Before you start

- Read the [Code of Conduct](./CODE_OF_CONDUCT.md). It applies everywhere in the project.
- For anything security-related, **do not open a public issue** — follow [SECURITY.md](./SECURITY.md) instead.
- Small fixes (typos, broken links, obvious bugs) — just open a PR. For anything larger, open an issue first so we can agree on the approach before you spend time on it.

## Repository layout

Ikenga is a multi-repo project under [`github.com/Royalti-io`](https://github.com/Royalti-io). This repo is the **shell** — the Tauri 2 desktop app and the pkg kernel. The rest of the platform lives in sibling repos:

| Repo | Role | Package manager |
|------|------|-----------------|
| `ikenga` (this repo) | Tauri 2 + Vite + React 19 desktop app + pkg kernel | **bun** |
| `ikenga-contract` | Shared TS package: manifest schema (Zod), RPC types, Engine interface, capability scopes | **pnpm** |
| `ikenga-tokens` | Canonical design tokens (CSS + TS) | **pnpm** |
| `ikenga-cli` | `ikenga` — disk-side pkg manager (`add \| update \| list \| dev`), bun-compiled binary | **bun** |
| `iyke-cli` | `iyke` — Rust runtime controller for a running shell | **cargo** |
| `ikenga-pkgs` | Canonical monorepo for all pkgs (engines, MCP servers, apps) | **pnpm** + Changesets |
| `ikenga-registry` | Static JSON registry of published pkgs | — |
| `ikenga-site` | Marketing site + docs (Starlight) for ikenga.dev | — |

> **Package managers vary by repo. This is deliberate — don't introduce a foreign lockfile.** Shell and the `ikenga` CLI use **bun**; the shared libraries (`contract`, `tokens`) and `ikenga-pkgs` use **pnpm**; `iyke-cli` uses **cargo**; `cc-config` (`ikenga-studio`) uses **node**.

## Local setup

You'll need a recent [Bun](https://bun.sh), [Node](https://nodejs.org), [pnpm](https://pnpm.io), and the [Rust toolchain](https://rustup.rs) (for the Tauri host and `iyke-cli`). Tauri also has [platform prerequisites](https://tauri.app/start/prerequisites/) — install those for your OS first.

### The shell (this repo)

```bash
# from the shell repo root
bun install
bun run tauri dev      # launches the desktop app with hot reload
```

See `CLAUDE.md` / `shell/CLAUDE.md` in-repo for the full command list (Tauri commands, sidecars, routes, the Iyke bridge).

### Shared libraries (separate repos)

If you're changing the manifest schema, RPC types, or design tokens, you'll be working in `ikenga-contract` or `ikenga-tokens`. Each builds with pnpm:

```bash
# in ikenga-contract
pnpm install
pnpm build      # tsc → dist/   (rebuild so consumers see your changes)
pnpm dev        # tsc --watch

# in ikenga-tokens
pnpm install
pnpm build
```

During cross-package dev these resolve through `workspace:*` links in the workspace `pnpm-workspace.yaml`. Rebuild the dependency, then the shell picks it up on next reload.

### The CLIs

```bash
# ikenga CLI (pkg manager) — bun
cd ikenga-cli
bun install
bun run dev -- <args>      # iterate
bun run build             # compile to a single binary

# iyke CLI (runtime controller) — cargo
cd iyke-cli
cargo build --release     # → target/release/iyke
```

### Authoring a pkg

If you're building a package rather than changing the platform, you don't need to touch the shell internals. Use `ikenga dev <path>` to hot-mount a pkg into a running shell (watches the manifest and reload globs; `Ctrl-C` unregisters cleanly). Per-archetype authoring guides (ui-iframe, ui-webview, mcp-server, engine, sidecar, skill-only) live in `docs/pkg-patterns/`, with copyable scaffolds in `docs/pkg-patterns/_templates/`.

## Filing issues

Use the templates — they exist so we can act on a report without a round-trip for missing detail.

- **Bug reports** — include your OS, Ikenga version, the engine adapter in use, and the smallest reproduction you can manage. See the bug template.
- **Feature requests** — describe the problem before the solution. See the feature template.
- **Security issues** — do **not** use public issues. See [SECURITY.md](./SECURITY.md).
- **Questions / ideas** — open a GitHub Discussion rather than an issue.

One report per issue. If you've found three bugs, file three issues.

## Branch, commit, and PR workflow

1. **Fork** the repo and create a branch off `main`. Name it for the work — `fix/iframe-handshake-race`, `feat/codex-adapter`, `docs/contributing-setup`.
2. **Commit** in logical units. We follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, e.g. `fix(kernel): unregister dev pkg on Ctrl-C`. Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Repos that publish through Changesets (e.g. `ikenga-pkgs`) also expect a changeset (`pnpm changeset`) for any user-facing change.
3. **Keep PRs focused.** One concern per PR. If it grew two unrelated changes, split it.
4. **Open the PR against `main`**, fill in the PR template, and link the issue it closes (`Closes #123`).
5. A maintainer will review. Expect questions — review is a conversation, not a gate. Push follow-up commits to the same branch; we squash on merge unless the history is worth keeping.

## Tests and standards

- Run the test suite for the repo you touched before opening a PR. The shell, contract, and CLIs each have their own (`cargo test`, `node --test`, package scripts — see the repo's `CLAUDE.md`).
- Match the existing style; don't reformat unrelated code in the same PR. Each repo's formatter/linter config is authoritative.
- Add or update tests for behavior you change. A bug fix should come with a test that would have caught it.
- Don't introduce a foreign package manager or lockfile (see the table above).

## Licensing and your contributions

Ikenga is **Apache-2.0**. We use **inbound = outbound**: by opening a pull request, you agree that your contribution is licensed under the same Apache-2.0 terms as the project. We do **not** require a CLA.

Why: an Apache-2.0 *license* does not by itself require a CLA — that's a foundation *governance* requirement, not a license one. Ikenga is Apache-2.0-licensed but is not an ASF project, so we keep contribution friction low the way most non-foundation OSS projects do.

<!-- DECISION: inbound=outbound vs DCO sign-off — The above uses plain inbound=outbound (no extra step for contributors). The lightweight alternative is a DCO sign-off (`git commit -s`, adding a `Signed-off-by:` trailer asserting the Developer Certificate of Origin at https://developercertificate.org/), optionally enforced by the DCO GitHub App. DCO gives a per-commit provenance record at the cost of one flag for contributors; inbound=outbound is zero-friction but relies on the PR-acceptance act as the agreement. Maintainer to choose before launch. If DCO is chosen, add a "sign your commits with `-s`" line to the workflow section above and enable the check. Either way, not a full CLA. -->

## Getting help

- Project docs: [ikenga.dev](https://ikenga.dev) (in-site Starlight docs).
- GitHub Discussions for questions and design conversation.
- Be patient and specific — the more reproducible your report, the faster we can help.

Welcome aboard.
