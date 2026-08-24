-- =============================================================================
-- 005_relax_config_insert_policies.sql
--
-- Context: the /config page (src/app/config/ConfigClient.tsx) lets any
-- authenticated user add production lines, teams, operators, and products —
-- matching how jobs/operations already behave. Verified against the live DB
-- on 2026-07-27: authenticated (non-admin) INSERT is currently rejected by
-- RLS on these four tables (42501), while jobs/operations/operation_times
-- already allow it. This adds a permissive INSERT policy for authenticated
-- users on the four tables, without touching existing UPDATE/DELETE
-- (admin-only) policies. Policies are additive/permissive in Postgres, so
-- this does not remove or weaken any existing restriction — it only adds a
-- path that allows the insert.
--
-- Review before applying. Not run automatically.
-- =============================================================================

drop policy if exists "production_lines: authenticated insert" on public.production_lines;
create policy "production_lines: authenticated insert"
  on public.production_lines for insert to authenticated with check (true);

drop policy if exists "teams: authenticated insert" on public.teams;
create policy "teams: authenticated insert"
  on public.teams for insert to authenticated with check (true);

drop policy if exists "operators: authenticated insert" on public.operators;
create policy "operators: authenticated insert"
  on public.operators for insert to authenticated with check (true);

drop policy if exists "products: authenticated insert" on public.products;
create policy "products: authenticated insert"
  on public.products for insert to authenticated with check (true);
