-- =============================================================================
-- 004_new_schema.sql
-- Full schema replacement: production_lines, teams, operators,
-- operator_change_requests, products, chassis, operations, model_operations,
-- stopwatch, stopwatch_notes.
-- Drops the old tryout_sessions / operations / notes / org-hierarchy schema.
-- `profiles` is untouched.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Drop old schema
-- ---------------------------------------------------------------------------
drop table if exists public.notes cascade;
drop table if exists public.operations cascade;
drop table if exists public.operator_work_centres cascade;
drop table if exists public.operation_templates cascade;
drop table if exists public.work_centres cascade;
drop table if exists public.operators cascade;
drop table if exists public.tryout_sessions cascade;
drop table if exists public.production_lines cascade;

-- ---------------------------------------------------------------------------
-- production_lines
-- ---------------------------------------------------------------------------
create table public.production_lines (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null unique,
  created_at timestamptz not null default now()
);

alter table public.production_lines enable row level security;

create policy "production_lines: authenticated read all"
  on public.production_lines for select to authenticated using (true);
create policy "production_lines: authenticated insert"
  on public.production_lines for insert to authenticated with check (true);
create policy "production_lines: admin update"
  on public.production_lines for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "production_lines: admin delete"
  on public.production_lines for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

insert into public.production_lines (name) values
  ('Caravan'),
  ('Motorhome'),
  ('Campervan'),
  ('Camper Trailer'),
  ('Pop Top'),
  ('JPod');

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------
create table public.teams (
  id                       uuid        primary key default gen_random_uuid(),
  name                     text        not null,
  production_line_id       uuid        not null references public.production_lines(id) on delete cascade,
  available_hours_per_day  numeric     not null default 7.5,
  created_at               timestamptz not null default now()
);

alter table public.teams enable row level security;

create policy "teams: authenticated read all"
  on public.teams for select to authenticated using (true);
create policy "teams: authenticated insert"
  on public.teams for insert to authenticated with check (true);
create policy "teams: authenticated update"
  on public.teams for update to authenticated using (true) with check (true);
create policy "teams: admin delete"
  on public.teams for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operators
-- ---------------------------------------------------------------------------
create table public.operators (
  id                 uuid        primary key default gen_random_uuid(),
  full_name          text        not null,
  employee_id        text        unique,
  team_id            uuid        references public.teams(id) on delete set null,
  production_line_id uuid        references public.production_lines(id) on delete set null,
  is_active          boolean     not null default true,
  created_at         timestamptz not null default now()
);

alter table public.operators enable row level security;

create policy "operators: authenticated read all"
  on public.operators for select to authenticated using (true);
create policy "operators: authenticated insert"
  on public.operators for insert to authenticated with check (true);
create policy "operators: admin update"
  on public.operators for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "operators: admin delete"
  on public.operators for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operator_change_requests
-- ---------------------------------------------------------------------------
create table public.operator_change_requests (
  id           uuid        primary key default gen_random_uuid(),
  operator_id  uuid        not null references public.operators(id) on delete cascade,
  requested_by uuid        references public.profiles(id),
  from_team_id uuid        references public.teams(id),
  to_team_id   uuid        not null references public.teams(id),
  reason       text,
  status       text        not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at   timestamptz not null default now()
);

alter table public.operator_change_requests enable row level security;

create policy "operator_change_requests: authenticated read all"
  on public.operator_change_requests for select to authenticated using (true);
create policy "operator_change_requests: insert own"
  on public.operator_change_requests for insert to authenticated with check (auth.uid() = requested_by);
create policy "operator_change_requests: admin update"
  on public.operator_change_requests for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "operator_change_requests: admin delete"
  on public.operator_change_requests for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table public.products (
  id                 uuid        primary key default gen_random_uuid(),
  code               text        not null unique,
  name               text        not null,
  production_line_id uuid        not null references public.production_lines(id) on delete cascade,
  created_at         timestamptz not null default now()
);

alter table public.products enable row level security;

create policy "products: authenticated read all"
  on public.products for select to authenticated using (true);
create policy "products: authenticated insert"
  on public.products for insert to authenticated with check (true);
create policy "products: admin update"
  on public.products for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "products: admin delete"
  on public.products for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- chassis
-- ---------------------------------------------------------------------------
create table public.chassis (
  id             uuid        primary key default gen_random_uuid(),
  chassis_number text        not null unique,
  product_id     uuid        not null references public.products(id) on delete cascade,
  created_at     timestamptz not null default now()
);

alter table public.chassis enable row level security;

create policy "chassis: authenticated read all"
  on public.chassis for select to authenticated using (true);
create policy "chassis: authenticated insert"
  on public.chassis for insert to authenticated with check (true);
create policy "chassis: admin update"
  on public.chassis for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "chassis: admin delete"
  on public.chassis for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operations
-- ---------------------------------------------------------------------------
create table public.operations (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null,
  team_id             uuid        references public.teams(id) on delete set null,
  current_operator_id uuid        references public.operators(id) on delete set null,
  production_line_id  uuid        references public.production_lines(id) on delete set null,
  created_at          timestamptz not null default now()
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

-- ---------------------------------------------------------------------------
-- model_operations (junction: which operations apply to which products)
-- ---------------------------------------------------------------------------
create table public.model_operations (
  operation_id uuid not null references public.operations(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  primary key (operation_id, product_id)
);

alter table public.model_operations enable row level security;

create policy "model_operations: authenticated read all"
  on public.model_operations for select to authenticated using (true);
create policy "model_operations: authenticated insert"
  on public.model_operations for insert to authenticated with check (true);
create policy "model_operations: admin delete"
  on public.model_operations for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- stopwatch
-- ---------------------------------------------------------------------------
create table public.stopwatch (
  id                      uuid        primary key default gen_random_uuid(),
  operation_id            uuid        not null references public.operations(id) on delete cascade,
  operator_id             uuid        not null references public.operators(id),
  chassis_id              uuid        references public.chassis(id),
  collected_by            uuid        references public.profiles(id),
  started_at              timestamptz not null default now(),
  paused_duration_seconds integer     not null default 0,
  completed_at            timestamptz,
  total_minutes           numeric     generated always as (
                            extract(epoch from (completed_at - started_at)) / 60.0
                            - paused_duration_seconds / 60.0
                          ) stored,
  created_at              timestamptz not null default now()
);

alter table public.stopwatch enable row level security;

create policy "stopwatch: authenticated read all"
  on public.stopwatch for select to authenticated using (true);
create policy "stopwatch: insert own"
  on public.stopwatch for insert to authenticated with check (auth.uid() = collected_by);
create policy "stopwatch: update own"
  on public.stopwatch for update to authenticated
  using (auth.uid() = collected_by)
  with check (auth.uid() = collected_by);
create policy "stopwatch: admin delete"
  on public.stopwatch for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- stopwatch_notes
-- ---------------------------------------------------------------------------
create table public.stopwatch_notes (
  id           uuid        primary key default gen_random_uuid(),
  stopwatch_id uuid        not null references public.stopwatch(id) on delete cascade,
  content      text        not null,
  created_by   uuid        references public.profiles(id),
  created_at   timestamptz not null default now()
);

alter table public.stopwatch_notes enable row level security;

create policy "stopwatch_notes: authenticated read all"
  on public.stopwatch_notes for select to authenticated using (true);
create policy "stopwatch_notes: insert own"
  on public.stopwatch_notes for insert to authenticated with check (auth.uid() = created_by);
create policy "stopwatch_notes: delete own"
  on public.stopwatch_notes for delete to authenticated using (auth.uid() = created_by);
create policy "stopwatch_notes: admin delete any"
  on public.stopwatch_notes for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- CSV import RPC functions
-- Each takes a jsonb array of row objects (from a parsed CSV) and upserts on
-- the natural key, skipping rows missing required fields. Returns
-- { inserted, updated, skipped }.
-- ---------------------------------------------------------------------------

create or replace function public.import_operators(rows jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  row_data      jsonb;
  v_inserted    int := 0;
  v_updated     int := 0;
  v_skipped     int := 0;
  v_team_id     uuid;
  v_line_id     uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  for row_data in select * from jsonb_array_elements(rows)
  loop
    if coalesce(row_data->>'full_name', '') = '' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_team_id := null;
    v_line_id := null;
    if coalesce(row_data->>'team_id', '') <> '' then
      v_team_id := (row_data->>'team_id')::uuid;
    end if;
    if coalesce(row_data->>'production_line_id', '') <> '' then
      v_line_id := (row_data->>'production_line_id')::uuid;
    end if;

    if coalesce(row_data->>'employee_id', '') <> '' then
      insert into public.operators (full_name, employee_id, team_id, production_line_id)
      values (row_data->>'full_name', row_data->>'employee_id', v_team_id, v_line_id)
      on conflict (employee_id) do update
        set full_name = excluded.full_name,
            team_id = excluded.team_id,
            production_line_id = excluded.production_line_id;
      v_updated := v_updated + 1;
    else
      insert into public.operators (full_name, team_id, production_line_id)
      values (row_data->>'full_name', v_team_id, v_line_id);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped);
end;
$$;

create or replace function public.import_products(rows jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  row_data   jsonb;
  v_inserted int := 0;
  v_updated  int := 0;
  v_skipped  int := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  for row_data in select * from jsonb_array_elements(rows)
  loop
    if coalesce(row_data->>'code', '') = ''
       or coalesce(row_data->>'name', '') = ''
       or coalesce(row_data->>'production_line_id', '') = '' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.products (code, name, production_line_id)
    values (row_data->>'code', row_data->>'name', (row_data->>'production_line_id')::uuid)
    on conflict (code) do update
      set name = excluded.name,
          production_line_id = excluded.production_line_id;
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped);
end;
$$;

create or replace function public.import_chassis(rows jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  row_data   jsonb;
  v_inserted int := 0;
  v_updated  int := 0;
  v_skipped  int := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  for row_data in select * from jsonb_array_elements(rows)
  loop
    if coalesce(row_data->>'chassis_number', '') = ''
       or coalesce(row_data->>'product_id', '') = '' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.chassis (chassis_number, product_id)
    values (row_data->>'chassis_number', (row_data->>'product_id')::uuid)
    on conflict (chassis_number) do update
      set product_id = excluded.product_id;
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped);
end;
$$;
