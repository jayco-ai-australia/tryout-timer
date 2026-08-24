-- =============================================================================
-- 006_profile_production_line.sql
--
-- Adds a production_line_id preference to profiles so a user's dashboard can
-- default to their production line, and so they can set it from /profile.
--
-- No RLS change needed: the "profiles: update own" policy from
-- 001_initial_schema.sql (using auth.uid() = id, no column list) already
-- covers updates to this new column.
-- =============================================================================

alter table public.profiles
  add column production_line_id uuid references public.production_lines(id);
