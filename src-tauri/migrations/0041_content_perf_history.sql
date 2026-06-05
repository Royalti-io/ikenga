-- 0041_content_perf_history — WP-10 residual: content_performance_history.
--
-- Empty in Supabase (0 rows) but written by pa-query's log-content-metrics; the
-- residual writer cutover needs a local target. Down-mapped from live
-- introspection (numeric rates → TEXT, integer counts → INTEGER).

CREATE TABLE IF NOT EXISTS content_performance_history (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  views INTEGER,
  clicks INTEGER,
  conversions INTEGER,
  conversion_rate TEXT,
  engagement_rate TEXT,
  bounce_rate TEXT,
  impressions INTEGER,
  open_rate TEXT,
  click_rate TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;
