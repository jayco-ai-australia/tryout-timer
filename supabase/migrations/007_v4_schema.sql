-- =============================================================================
-- 007_v4_schema.sql
--
-- Reference migration for the v4 schema. The live production database was
-- already migrated to this shape by hand (verified via direct PostgREST
-- introspection on 2026-08-03) — this file exists so the migrations folder
-- is an accurate record of that schema and so a fresh local/dev database can
-- be bootstrapped to match production. Do NOT run this against production.
--
-- Supersedes the `stopwatch` / `stopwatch_notes` / `operations.current_operator_id`
-- shape introduced in 004_new_schema.sql, which is no longer live.
-- =============================================================================

drop table if exists public.stopwatch_notes cascade;
drop table if exists public.stopwatch cascade;
drop table if exists public.operations cascade;

-- ---------------------------------------------------------------------------
-- products: replace code/name with the v4 column set
-- ---------------------------------------------------------------------------
alter table public.products rename column code to product_code;
alter table public.products rename column name to model;
alter table public.products add column product_series text;
alter table public.products add column product_type text;
alter table public.products add column year integer;
alter table public.products add column productionfacility text;
alter table public.products alter column production_line_id drop not null;

-- ---------------------------------------------------------------------------
-- chassis: replace chassis_number/product-only shape with the v4 column set
-- ---------------------------------------------------------------------------
alter table public.chassis rename column chassis_number to chassisnumber;
alter table public.chassis add column fk_order_id text;
alter table public.chassis add column model text;
alter table public.chassis add column dealer text;
alter table public.chassis add column dateonline date;
alter table public.chassis add column dateoffline date;
alter table public.chassis add column runnumber text;
alter table public.chassis add column despatchstatus text;
alter table public.chassis alter column product_id drop not null;
alter table public.chassis alter column product_id set default null;

-- ---------------------------------------------------------------------------
-- jobs (new — sits between teams and operations)
-- ---------------------------------------------------------------------------
create table public.jobs (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null,
  primary_operator_id uuid        references public.operators(id) on delete set null,
  team_id             uuid        references public.teams(id) on delete set null,
  production_line_id  uuid        references public.production_lines(id) on delete set null,
  created_at          timestamptz not null default now()
);

alter table public.jobs enable row level security;

create policy "jobs: authenticated read all"
  on public.jobs for select to authenticated using (true);
create policy "jobs: authenticated insert"
  on public.jobs for insert to authenticated with check (true);
create policy "jobs: authenticated update"
  on public.jobs for update to authenticated using (true) with check (true);
create policy "jobs: admin delete"
  on public.jobs for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operations (v4: belongs to a job, primary + optional secondary operator)
-- ---------------------------------------------------------------------------
create table public.operations (
  id                    uuid        primary key default gen_random_uuid(),
  name                  text        not null,
  job_id                uuid        not null references public.jobs(id) on delete cascade,
  primary_operator_id   uuid        references public.operators(id) on delete set null,
  secondary_operator_id uuid        references public.operators(id) on delete set null,
  created_at            timestamptz not null default now()
);

alter table public.operations enable row level security;

create policy "operations: authenticated read all"
  on public.operations for select to authenticated using (true);
create policy "operations: authenticated insert"
  on public.operations for insert to authenticated with check (true);
create policy "operations: authenticated update"
  on public.operations for update to authenticated using (true) with check (true);
create policy "operations: admin delete"
  on public.operations for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- model_operations already exists (created in 004) and is unchanged: junction
-- of operation_id + product_id, used for gap tracking.

-- ---------------------------------------------------------------------------
-- operation_times (v4 rename of `stopwatch`; total_minutes is a plain column
-- so manually-entered / imported averages can be saved without start/stop
-- timestamps)
-- ---------------------------------------------------------------------------
create table public.operation_times (
  id                      uuid        primary key default gen_random_uuid(),
  operation_id            uuid        not null references public.operations(id) on delete cascade,
  operator_id             uuid        not null references public.operators(id),
  collected_by            uuid        references public.profiles(id),
  chassis_id              uuid        references public.chassis(id),
  started_at              timestamptz,
  paused_duration_seconds integer     not null default 0,
  completed_at            timestamptz,
  total_minutes           numeric,
  is_imported             boolean     not null default false,
  team_id                 uuid        references public.teams(id),
  production_line_id      uuid        references public.production_lines(id),
  created_at              timestamptz not null default now()
);

alter table public.operation_times enable row level security;

create policy "operation_times: authenticated read all"
  on public.operation_times for select to authenticated using (true);
create policy "operation_times: insert own"
  on public.operation_times for insert to authenticated with check (auth.uid() = collected_by);
create policy "operation_times: update own"
  on public.operation_times for update to authenticated
  using (auth.uid() = collected_by)
  with check (auth.uid() = collected_by);
create policy "operation_times: admin delete"
  on public.operation_times for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operation_time_models (junction: one operation_time applies to many models)
-- ---------------------------------------------------------------------------
create table public.operation_time_models (
  operation_time_id uuid not null references public.operation_times(id) on delete cascade,
  product_id        uuid not null references public.products(id) on delete cascade,
  primary key (operation_time_id, product_id)
);

alter table public.operation_time_models enable row level security;

create policy "operation_time_models: authenticated read all"
  on public.operation_time_models for select to authenticated using (true);
create policy "operation_time_models: authenticated insert"
  on public.operation_time_models for insert to authenticated with check (true);
create policy "operation_time_models: admin delete"
  on public.operation_time_models for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operation_time_notes (v4 rename of `stopwatch_notes`)
-- ---------------------------------------------------------------------------
create table public.operation_time_notes (
  id                 uuid        primary key default gen_random_uuid(),
  operation_time_id  uuid        not null references public.operation_times(id) on delete cascade,
  content            text        not null,
  created_by         uuid        references public.profiles(id),
  created_at         timestamptz not null default now()
);

alter table public.operation_time_notes enable row level security;

create policy "operation_time_notes: authenticated read all"
  on public.operation_time_notes for select to authenticated using (true);
create policy "operation_time_notes: insert own"
  on public.operation_time_notes for insert to authenticated with check (auth.uid() = created_by);
create policy "operation_time_notes: delete own"
  on public.operation_time_notes for delete to authenticated using (auth.uid() = created_by);
create policy "operation_time_notes: admin delete any"
  on public.operation_time_notes for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
