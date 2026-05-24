# Security Policy

We take the security of Ikenga seriously. Ikenga is a local-first desktop workspace that runs an AI engine, executes pkgs, and holds secrets in a vault — so we'd rather hear about a problem from you than read about it later. Thank you for taking the time to report responsibly.

## Supported versions

Ikenga is pre-1.0 and ships frequently. We provide security fixes for the **latest released version** on the default branch. Older versions are not patched in place — upgrade to the latest release to receive fixes.

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Older releases | ❌ (upgrade to latest) |

<!-- VERIFY: confirm this matches the actual release cadence once the first GitHub Release exists — WP-13. If we adopt a versioned support window post-1.0, replace this table. -->

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Use one of these private channels instead:

1. **GitHub Private Vulnerability Reporting (preferred).** Go to the **Security** tab of the affected repository → **Report a vulnerability**. This opens a private advisory visible only to you and the maintainers, with a built-in space to collaborate on a fix and coordinate disclosure.
2. **Email.** If you can't use GitHub's reporting, email <!-- VERIFY: contact -->. Encrypt if you can; ask for a key in your first message if needed.

Please include:

- The affected repo and version (or commit).
- A description of the issue and its impact.
- Steps to reproduce, a proof-of-concept, or affected source paths.
- Your platform/OS and the engine adapter in use, if relevant.

## What to expect

- **Acknowledgement within 3 business days** of your report.
- **An initial assessment within 7 business days**, including whether we've confirmed the issue and a rough remediation timeline.
- We'll keep you updated as we work on a fix, and we'll let you know when it ships.

<!-- VERIFY: confirm these SLAs are realistic for the current maintainer capacity before publishing. -->

## Coordinated disclosure

We follow coordinated disclosure. We ask that you give us a reasonable window to investigate and ship a fix before any public disclosure — **90 days** from your report, or sooner once a fix is released, whichever comes first. We'll work with you on timing if a fix needs longer.

When a fix ships, we'll publish a security advisory crediting you (unless you'd prefer to remain anonymous — just say so). We don't currently run a paid bug-bounty program, but we genuinely appreciate every good-faith report and will recognize your contribution publicly.

## Scope

This policy covers the Ikenga platform repos under [`github.com/Royalti-io`](https://github.com/Royalti-io) — the shell, the CLIs (`ikenga`, `iyke`), the contract/tokens libraries, and first-party pkgs in `ikenga-pkgs`. Third-party pkgs you install are outside this policy; report those to their authors. If you're unsure whether something is in scope, report it privately and we'll route it.
