-- =============================================================================
-- 001_initial_schema.sql
-- Tables: profiles, tryout_sessions, operations
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        text        not null default 'user' check (role in ('user', 'admin')),
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- authenticated users can read all profiles
create policy "profiles: authenticated read all"
  on public.profiles
  for select
  to authenticated
  using (true);

-- users can update only their own profile
create policy "profiles: update own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- tryout_sessions
-- ---------------------------------------------------------------------------
create table public.tryout_sessions (
  id              uuid        primary key default gen_random_uuid(),
  chassis_number  text        not null,
  created_by      uuid        references public.profiles(id),
  created_at      timestamptz not null default now(),
  notes           text
);

alter table public.tryout_sessions enable row level security;

-- authenticated users can read all sessions
create policy "tryout_sessions: authenticated read all"
  on public.tryout_sessions
  for select
  to authenticated
  using (true);

-- authenticated users can insert their own sessions
create policy "tryout_sessions: insert own"
  on public.tryout_sessions
  for insert
  to authenticated
  with check (auth.uid() = created_by);

-- admins can delete any session
create policy "tryout_sessions: admin delete any"
  on public.tryout_sessions
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- operations
-- ---------------------------------------------------------------------------
create table public.operations (
  id                      uuid      primary key default gen_random_uuid(),
  session_id              uuid      not null references public.tryout_sessions(id) on delete cascade,
  operator_name           text      not null,
  stage                   text      not null,
  operation_name          text      not null,
  started_at              timestamptz,
  paused_duration_seconds integer   not null default 0,
  completed_at            timestamptz,
  total_minutes           numeric   generated always as (
                            extract(epoch from (completed_at - started_at)) / 60.0
                            - paused_duration_seconds / 60.0
                          ) stored,
  notes                   text,
  created_by              uuid      references public.profiles(id),
  created_at              timestamptz not null default now()
);

alter table public.operations enable row level security;

-- authenticated users can read all operations
create policy "operations: authenticated read all"
  on public.operations
  for select
  to authenticated
  using (true);

-- authenticated users can insert their own operations
create policy "operations: insert own"
  on public.operations
  for insert
  to authenticated
  with check (auth.uid() = created_by);

-- authenticated users can update their own operations
create policy "operations: update own"
  on public.operations
  for update
  to authenticated
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by);

-- admins can delete any operation
create policy "operations: admin delete any"
  on public.operations
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- trigger: auto-create profile on new auth.users row
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
