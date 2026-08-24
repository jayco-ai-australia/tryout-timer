-- =============================================================================
-- 003_org_hierarchy.sql
-- Tables: production_lines, work_centres, operators, operator_work_centres,
--         operation_templates
-- Also extends: operations table with FK columns
-- =============================================================================

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

create policy "production_lines: admin insert"
  on public.production_lines for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

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
-- work_centres
-- ---------------------------------------------------------------------------
create table public.work_centres (
  id                 uuid        primary key default gen_random_uuid(),
  production_line_id uuid        not null references public.production_lines(id) on delete cascade,
  name               text        not null,
  created_at         timestamptz not null default now()
);

alter table public.work_centres enable row level security;

create policy "work_centres: authenticated read all"
  on public.work_centres for select to authenticated using (true);

create policy "work_centres: admin insert"
  on public.work_centres for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "work_centres: admin update"
  on public.work_centres for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "work_centres: admin delete"
  on public.work_centres for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operators
-- ---------------------------------------------------------------------------
create table public.operators (
  id                 uuid        primary key default gen_random_uuid(),
  production_line_id uuid        references public.production_lines(id),
  full_name          text        not null,
  employee_id        text,
  created_at         timestamptz not null default now()
);

alter table public.operators enable row level security;

create policy "operators: authenticated read all"
  on public.operators for select to authenticated using (true);

create policy "operators: admin insert"
  on public.operators for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "operators: admin update"
  on public.operators for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "operators: admin delete"
  on public.operators for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operator_work_centres (junction - operators can float across work centres)
-- ---------------------------------------------------------------------------
create table public.operator_work_centres (
  operator_id    uuid not null references public.operators(id) on delete cascade,
  work_centre_id uuid not null references public.work_centres(id) on delete cascade,
  primary key (operator_id, work_centre_id)
);

alter table public.operator_work_centres enable row level security;

create policy "operator_work_centres: authenticated read all"
  on public.operator_work_centres for select to authenticated using (true);

create policy "operator_work_centres: admin insert"
  on public.operator_work_centres for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "operator_work_centres: admin delete"
  on public.operator_work_centres for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- operation_templates
-- ---------------------------------------------------------------------------
create table public.operation_templates (
  id             uuid        primary key default gen_random_uuid(),
  work_centre_id uuid        not null references public.work_centres(id) on delete cascade,
  name           text        not null,
  created_at     timestamptz not null default now()
);

alter table public.operation_templates enable row level security;

create policy "operation_templates: authenticated read all"
  on public.operation_templates for select to authenticated using (true);

create policy "operation_templates: admin insert"
  on public.operation_templates for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "operation_templates: admin update"
  on public.operation_templates for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "operation_templates: admin delete"
  on public.operation_templates for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---------------------------------------------------------------------------
-- Extend operations with FK columns (nullable for backwards compatibility)
-- ---------------------------------------------------------------------------
alter table public.operations
  add column production_line_id    uuid references public.production_lines(id),
  add column work_centre_id        uuid references public.work_centres(id),
  add column operator_id           uuid references public.operators(id),
  add column operation_template_id uuid references public.operation_templates(id);
