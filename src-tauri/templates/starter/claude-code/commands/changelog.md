---
description: Draft a changelog or newsletter entry from a list of shipped items.
allowed-tools:
  - Task
  - Read
  - Write
  - Edit
  - Glob
  - Grep
argument-hint: <period or theme, e.g. "this week" or "Q3 wrap-up">
---

# /changelog

Routes to the `content-curator` agent with the `changelog-drafter`
skill.

## Behaviour

1. Asks the user (or reads from a file) for the raw list of items.
2. Produces a markdown changelog entry with a headline, framing line,
   and ≤6 bullets.
3. Saves under `changelog/{YYYY-MM-DD}.md` unless the user specifies a
   different target.
