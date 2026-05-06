# pa-actions sidecar

Single bun-compiled binary that absorbs every mutation + poller previously hosted in the retired `ikenga/` Next.js server (now living as scripts in `royalti-pa/`).

## Modes

```bash
# One-shot (cron / manual)
pa-actions resend-poll
pa-actions twenty-poll
pa-actions email-send <draft-id>
pa-actions fundraising-send

# Daemon (Tauri long-lived)
pa-actions --daemon
# then write JSON-RPC requests to stdin:
# {"id":"x","subcommand":"resend-poll","args":[]}
```

## Subcommands

| Subcommand | Phase | Purpose | Impl |
|---|---|---|---|
| `resend-poll` | A | Catch up newsletter_sends + ingest inbound replies (replaces /api/webhooks/resend) | inline |
| `twenty-poll` | A | Pull recent workflow runs from Twenty CRM (replaces /api/webhooks/twenty-callback) | inline |
| `listmonk-poll` | B | Poll Listmonk campaign stats → newsletter_sends | delegated → `royalti-pa/scripts/poll-listmonk-campaigns.ts` |
| `send-scheduled` | B | Sweep approved/scheduled drafts whose `scheduled_for` has passed | delegated → `royalti-pa/scripts/send-scheduled.ts` |
| `email-send` | B | Send a single draft by id (sets `SEND_SCHEDULED_DRAFT_ID`) | delegated → `royalti-pa/scripts/send-scheduled.ts` |
| `reply-send` | B | Send a single approved row from `email_replies` via cPanel SMTP, threaded via In-Reply-To | inline |
| `fundraising-send` | B | Send approved fundraising outreach via Resend | delegated → `royalti-pa/scripts/send-fundraising-outreach.ts` |
| `sequence-advance` | B | Advance `email_sequences` by one step (curl-based) | delegated → `scripts/cron/sequence-advancer.sh` |

`inline` subcommands are fully vendored in `src/`. `delegated` subcommands shell out via `tsx` to the canonical script in `royalti-pa/scripts/` — which exists as a shared library directory (see `royalti-pa/CLAUDE.md`).

## Env

Loaded in this order (first match wins per key):
1. `PA_ACTIONS_ENV_FILE` (explicit override)
2. `~/.config/pa-actions/env` (cron / production)
3. `royalti-co/royalti-pa/.env` (transition fallback)

Required:
- `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`

Optional (subcommand-dependent):
- `TWENTY_API_URL`, `TWENTY_API_KEY` (twenty-poll)
- `LISTMONK_API_URL`, `LISTMONK_USERNAME`, `LISTMONK_PASSWORD` (listmonk-poll, send-scheduled blocklist check)
- `RUBY_IMAP_HOST`, `RUBY_IMAP_USER`, `RUBY_IMAP_PASS`, `RUBY_SMTP_PORT` (reply-send via cPanel SMTP)
- `MM_CHANNEL_PA`, `MM_CHANNEL_ALERTS` (Mattermost notifications)

## Build

```bash
./build.sh                              # autodetect target
./build.sh x86_64-unknown-linux-gnu     # explicit
```

Output: `dist/pa-actions-<triple>` + `dist/pa-actions` symlink for cron.

## Output protocol

Every invocation writes one JSON line to stdout:

```json
{"ok": true, "subcommand": "resend-poll", "durationMs": 423, "result": {...}}
{"ok": false, "subcommand": "x", "durationMs": 5, "error": "..."}
```

Exit codes: `0` ok, `1` runtime error, `2` bad subcommand / bad args.

Logs go to stderr (prefixed `[pa-actions]`).

## Observability

Every run is recorded in `agent_runs` (agent_name=`pa-actions`, command=subcommand, triggered_by=cron|desktop|manual). Surfaces on the desktop's `/cron` page.
