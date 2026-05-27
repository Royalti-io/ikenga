-- 0028_sales_gtm_domain — Atelier/PA "sales / GTM / partnerships / fundraising".
--
-- Down-mapped from royalti-pa Supabase migrations:
--   003_phase2_schema.sql (sales_stage_transitions, sales_lead_scores,
--                          sales_forecasts, partnership_deals)
--   015_sales_deals.sql + 019 (sales_deals + ALTERs; sales_stage_transitions
--                              deal_id ALTER)
--   020_fundraising_deals.sql (fundraising_deals, fundraising_activities)
--   023_fundraising_outreach.sql + 024 (fundraising_outreach + ALTERs)
--
-- numeric(p,s) → TEXT (money/precision is never stored as REAL). int → INTEGER.
-- Cross-domain FK REFERENCES (initiative_id → strategic_initiatives, deal_id →
-- sales_deals, etc.) dropped; columns kept as TEXT soft links. CHECK enums
-- dropped → free-form TEXT.

CREATE TABLE IF NOT EXISTS sales_deals (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  stage TEXT NOT NULL DEFAULT 'lead',
  value TEXT DEFAULT '0',
  currency TEXT DEFAULT 'USD',
  score INTEGER DEFAULT 0,
  last_contact TEXT,
  assigned_to TEXT,
  notes TEXT,
  source TEXT,
  loss_reason TEXT,
  description TEXT,
  expected_close_date TEXT,
  days_in_stage INTEGER DEFAULT 0,
  stage_entered_date TEXT,
  initiative_id TEXT,
  extra TEXT,
  created_at TEXT,
  updated_at TEXT,
  -- 019_sales_deals_additions
  segment TEXT,
  trial_start_date TEXT,
  trial_end_date TEXT,
  do_not_contact INTEGER DEFAULT 0,
  conference_met TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sales_stage_transitions (
  id TEXT PRIMARY KEY,
  notion_deal_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  deal_value TEXT,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  transition_date TEXT NOT NULL,
  days_in_previous_stage INTEGER,
  trigger TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  -- 015_sales_deals
  deal_id TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sales_lead_scores (
  id TEXT PRIMARY KEY,
  notion_deal_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  score_date TEXT NOT NULL,
  total_score INTEGER NOT NULL,
  company_fit_score INTEGER,
  need_indicators_score INTEGER,
  engagement_score INTEGER,
  priority TEXT NOT NULL,
  scoring_notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sales_forecasts (
  id TEXT PRIMARY KEY,
  forecast_date TEXT NOT NULL,
  quarter TEXT NOT NULL,
  total_pipeline_value TEXT,
  weighted_pipeline_value TEXT,
  deal_count INTEGER,
  conservative_forecast TEXT,
  likely_forecast TEXT,
  optimistic_forecast TEXT,
  by_stage TEXT,
  top_deals TEXT,
  notes TEXT,
  initiative_id TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS partnership_deals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'research',
  priority TEXT NOT NULL DEFAULT 'cool',
  owner_agent TEXT,
  total_score INTEGER,
  strategic_fit_score INTEGER,
  revenue_potential_score INTEGER,
  execution_effort_score INTEGER,
  contact_name TEXT,
  contact_email TEXT,
  contact_title TEXT,
  website TEXT,
  description TEXT,
  revenue_year1_usd TEXT,
  revenue_year2_usd TEXT,
  revenue_year3_usd TEXT,
  npv_3yr_usd TEXT,
  resource_weeks TEXT,
  stage_entered_date TEXT,
  days_in_stage INTEGER DEFAULT 0,
  last_activity_date TEXT,
  next_action TEXT,
  next_action_date TEXT,
  health_score TEXT,
  monthly_revenue_usd TEXT,
  integration_status TEXT,
  contract_end_date TEXT,
  initiative_id TEXT,
  folder_path TEXT,
  extra TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS fundraising_deals (
  id TEXT PRIMARY KEY,
  investor_name TEXT NOT NULL,
  investor_type TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_linkedin TEXT,
  stage TEXT NOT NULL DEFAULT 'research',
  source TEXT,
  intro_from TEXT,
  check_size TEXT,
  valuation TEXT,
  dilution_pct TEXT,
  instrument TEXT,
  priority TEXT DEFAULT 'medium',
  notes TEXT,
  loss_reason TEXT,
  next_step TEXT,
  next_step_date TEXT,
  first_contact_at TEXT,
  last_contact_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS fundraising_activities (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS fundraising_outreach (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  sequence_number INTEGER NOT NULL DEFAULT 1,
  drafted_by TEXT NOT NULL DEFAULT 'fundraising-agent',
  approved_by TEXT,
  approved_at TEXT,
  rejected_reason TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 024_outreach_application_channel
  application_url TEXT,
  application_deadline TEXT,
  application_fields TEXT
) STRICT;
