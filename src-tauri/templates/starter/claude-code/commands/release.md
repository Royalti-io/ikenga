---
description: Open or update the release plan for a given title. Dispatches to the release-coordinator agent.
allowed-tools:
  - Task
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
argument-hint: <artist - title>
---

# /release

Routes to the `release-coordinator` agent with $ARGUMENTS as the release
identifier (artist + title).

## Behaviour

1. If `releases/*` already contains a plan whose slug matches, open and
   update it.
2. Otherwise, create a new plan via the `release-planner` skill.
3. Always finish by printing the 3-line status summary: done / blocking
   / next milestone.
