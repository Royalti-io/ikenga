---
"ikenga-desktop": patch
---

0.2.9 — release the 12 commits accumulated since v0.2.8:

- **AskUserQuestion inline turn** (ADR-011 Phase 3) in chat
- **Pkg orphan/broken-install detection** with one-click cleanup
- **DB migrations 0052/0053/0054** — social_queue `media_url` + `hashtags`; atelier wave-4 research + strategy domains
- **fix:** bind `viewer_port` (not `_viewer_port`) so the release-window URL compiles
- **fix:** harden the sidecar supervisor against wedged children
- **ci:** single universal macOS build to cut Actions cost

No breaking changes; advances the auto-update channel off the v0.2.7 stopgap.
