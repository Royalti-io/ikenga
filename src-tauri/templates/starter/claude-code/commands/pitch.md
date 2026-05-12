---
description: Draft an outreach email to a music-industry contact. Dispatches to the outbound-agent.
allowed-tools:
  - Task
  - Read
  - Write
  - AskUserQuestion
  - WebSearch
  - WebFetch
argument-hint: <recipient name and hook, e.g. "Jane at XL — new EP">
---

# /pitch

Routes to the `outbound-agent` with $ARGUMENTS describing the recipient
and hook.

## Behaviour

1. Confirms the four required inputs (sender, recipient, hook, ask)
   before drafting.
2. Produces both a `direct` and `warmer` variant with subjects.
3. Flags anything that was guessed at — never presents a guess as fact.
