-- 0052_social_media_hashtags — Add media_url + hashtags columns to social_queue.
-- Canonical schema home for live producers (Buffer worker, cmo-agent fan-out)
-- that stamp media + tag data on the social_queue row.
-- The outbound pkg reads from pa_action_drafts.payload_json (item.media_url /
-- item.hashtags) — this migration is the durable store on the source table.
-- hashtags is stored as a JSON TEXT array, e.g. '["#royalti","#musicbusiness"]'.
-- No CHECK constraints (enums -> TEXT to keep the migration robust against
-- value drift). No triggers, no block comments — two plain ADD COLUMN statements
-- safe to split on ';'.
ALTER TABLE social_queue ADD COLUMN media_url TEXT;
ALTER TABLE social_queue ADD COLUMN hashtags TEXT;
