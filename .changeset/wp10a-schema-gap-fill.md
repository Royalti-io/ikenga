---
"ikenga-desktop": patch
---

Full-domain local-store schema gap-fill: embed migrations 0032–0041 (pure-ETL drift fix, `latest_account_balances` view + deterministic id-DESC tie-break, the 14 remaining business tables down-mapped from live Supabase introspection, and `content_performance_history`), bringing the embedded runner to 41 migrations and in line with the canonical ikenga.db. Also hide `visibility: hidden` registry entries (dev/test fixtures + scaffolds) from the default pkg catalog — they stay installable by exact name and keep update detection.
