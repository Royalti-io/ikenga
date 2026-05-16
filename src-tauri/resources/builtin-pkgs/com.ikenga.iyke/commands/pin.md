---
description: Read, acknowledge, or resolve an artifact-grid pin comment.
argument-hint: read|ack|resolve <pin-id>
---

Artifact-grid pin operations. The routing dispatcher pastes a short prompt like `address pin #N (artifact: foo.html · selector: #bar)` when the user clicks a pin in the grid. From there:

- **`read N`** — call `iyke_pin_read` to fetch the full structured payload: artifact_path (on-disk file to edit), selector (CSS selector inside the iframe), text (the user's comment body), screenshot_path (local PNG, may be null).
- **`ack N`** — call `iyke_pin_acknowledge` once you've read the pin and started working. The grid cell's pin dot flips kola-amber.
- **`resolve N`** — call `iyke_pin_resolve` once the targeted change is committed. Pin dot flips verdigris.

Run `iyke_pin_read <id>` first whenever a `address pin #N` prompt arrives — that's the canonical entry point.
