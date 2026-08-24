-- ---------------------------------------------------------------------------
-- operation_times.is_active — catch-up only
--
-- This column already exists in the live database; it was added out of band and
-- never made it into a migration, so a fresh provision from this folder built a
-- schema the app could not query. This migration is that catch-up and nothing
-- more: `if not exists` on the column, so it is a no-op against prod.
--
-- WHAT IT MEANS — read before writing any query against it.
--
-- It is NOT a per-time "an admin hid this" flag, however much the name suggests
-- one. Measured 2026-08-20 against prod: 759 of 1244 rows are false, 750 of
-- those imported, all created 6–11 Aug. It marks the import batch that the
-- re-import of 10–11 Aug superseded — flagged instead of deleted. Those rows
-- are ordinary history and carry most of the recorded coverage (on the Caravan
-- line, 758 of the 781 times linked to its models are in that batch).
--
-- So: reads must NOT filter `is_active = true`. Doing so was tried and reverted
-- — it dropped 61% of every average and total in the app and took /dashboard
-- coverage from 68.0% to 0.5%.
--
-- If per-time hiding is wanted later, add a separate column that means only
-- that, or reconcile the legacy batch first. Do not overload this one.
-- ---------------------------------------------------------------------------

alter table public.operation_times
  add column if not exists is_active boolean not null default true;
