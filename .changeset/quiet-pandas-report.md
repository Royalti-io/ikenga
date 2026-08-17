---
'ikenga-desktop': patch
---

Fix the approve gate silently discarding Reject / Approve / Retry clicks.

Two independent bugs combined into a single silent failure: `pausedDraftFromRow`
never copied `row.id` onto the view model, so every action invoked with
`draftId: undefined`, and `pa_actions_reject`'s WHERE clause refused the
`failed` rows the panel actually offers Reject on. The panel optimistically
marked the row resolved and removed it either way, so the gate looked like it
had worked while the database was untouched.

Cherry-picked to main from `spike/sandbox-containment`, where it was blocked
behind unrelated artifact-sandbox work.
