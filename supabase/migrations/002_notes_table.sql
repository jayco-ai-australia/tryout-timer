-- =============================================================================
-- 002_notes_table.sql
-- Add notes table with one-to-many relationship to operations
-- Drop the notes column from operations (superseded by this table)
-- =============================================================================

CREATE TABLE public.notes (
  id           uuid        primary key default gen_random_uuid(),
  operation_id uuid        not null references public.operations(id) on delete cascade,
  content      text        not null,
  created_by   uuid        references public.profiles(id),
  created_at   timestamptz not null default now()
);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notes: authenticated read all"
  ON public.notes FOR SELECT TO authenticated USING (true);

CREATE POLICY "notes: insert own"
  ON public.notes FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "notes: delete own"
  ON public.notes FOR DELETE TO authenticated
  USING (auth.uid() = created_by);

CREATE POLICY "notes: admin delete any"
  ON public.notes FOR DELETE TO authenticated
  USING (exists (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));

ALTER TABLE public.operations DROP COLUMN IF EXISTS notes;
