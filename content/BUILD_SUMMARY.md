# J-Motion — Build Status Summary

Generated from a direct read of the codebase at `/Users/jaycoai/Projects/tryout-timer` (branch `main`). Everything below reflects what is actually implemented in code, not the intended design.

---

## 1. Stack & structure

**Framework / runtime**
- Next.js `14.2.35` (App Router), React `18`, TypeScript `5`, strict mode on (`tsconfig.json`)
- Deployed with `basePath`/`assetPrefix` `/jmotion` (`next.config.mjs`), served by PM2 as process `j-motion` on port `3001` (`ecosystem.config.js`), `next start` in production

**Key dependencies** (`package.json`)
- `@supabase/ssr` `^0.6.1` + `@supabase/supabase-js` `^2.108.0` — auth/data layer
- `recharts` `^3.8.1` — the takt bar chart on `/analytics`
- `jspdf` `^3.0.4` — job PDF export (`src/lib/pdf.ts`)
- No ORM, no state-management library, no form library, no test runner/framework in `package.json` — every page manages its own `useState`/`useEffect` data fetching directly against the Supabase client

**Folder layout**
```
src/app/            Next.js App Router — one folder per route, each with page.tsx (server) + <Name>Client.tsx (client component)
src/app/auth/callback/route.ts   OAuth/magic-link code exchange endpoint
src/components/      Nav, ConfirmDialog, Modal, ServiceWorkerRegister
src/lib/             supabase/{client,server,service}.ts, types.ts, takt.ts, csv.ts, format.ts, pdf.ts, useLocalStorage.ts
src/middleware.ts    session refresh + route protection
supabase/migrations/ 001–007, hand-written SQL, no Supabase CLI migration tooling wired in (no supabase/config.toml)
public/              manifest.json, sw.js, offline.html, icons/ — basic PWA shell
```
- Routes present: `/`, `/login`, `/auth/callback`, `/dashboard`, `/setup`, `/collect`, `/validate`, `/gaps`, `/analytics`, `/records`, `/config`, `/admin`, `/profile`. `/` (`src/app/page.tsx`) is just `redirect('/dashboard')`.
- Every client component talks to Supabase directly (no API routes/server actions for data mutations except the auth callback route) — all authorization is via Postgres RLS policies plus a middleware role check for `/admin` and `/config`.

---

## 2. Database

Schema history is 7 migrations, several of which **replace** earlier shapes rather than add to them. The file `007_v4_schema.sql` states outright it's a *reference* migration reconstructed from the live DB, not something to run against production — so migrations 001–006 are not a reliable "run in order" history; 007 + surviving parts of 004/006 is the actual current shape.

### Tables mapped to the requested J-Motion schema (current/live shape, all present)

| Table | Defined in | Columns (current) | Notes |
|---|---|---|---|
| `profiles` | `001_initial_schema.sql` + `006_profile_production_line.sql` | `id (PK, = auth.users.id)`, `full_name`, `role ('user'|'admin')`, `created_at`, `production_line_id` | Auto-created by trigger, see §3 |
| `production_lines` | `003` → recreated `004_new_schema.sql` | `id`, `name (unique)`, `created_at` | Seeded with 6 rows (Caravan, Motorhome, Campervan, Camper Trailer, Pop Top, JPod) |
| `teams` | `004` | `id`, `name`, `production_line_id`, `available_hours_per_day (default 7.5)`, `created_at` | |
| `operators` | `003` → recreated `004` | `id`, `full_name`, `employee_id (unique)`, `team_id`, `production_line_id`, `is_active`, `created_at` | |
| `products` | `004` → altered `007_v4_schema.sql` | `id`, `product_code` (renamed from `code`), `model` (renamed from `name`), `product_series`, `product_type`, `year`, `productionfacility`, `production_line_id (nullable)`, `created_at` | |
| `chassis` | `004` → altered `007` | `id`, `chassisnumber` (renamed from `chassis_number`), `fk_order_id`, `model`, `dealer`, `dateonline`, `dateoffline`, `runnumber`, `despatchstatus`, `product_id (nullable)`, `created_at` | See §5/§7 — no write path exists in the app |
| `jobs` | `007` (new) | `id`, `name`, `primary_operator_id`, `team_id`, `production_line_id`, `created_at` | Sits between teams and operations |
| `operations` | `004` → **dropped and recreated** by `007` | `id`, `name`, `job_id`, `primary_operator_id`, `secondary_operator_id`, `created_at` | v4 shape belongs to a job with primary+secondary operator, replacing the 004 shape (`team_id`/`current_operator_id`) |
| `model_operations` | `004`, unchanged since | `operation_id`, `product_id` (composite PK) | Junction: which operations apply to which products |
| `operation_times` | `007`, renamed from `stopwatch` (`004`) | `id`, `operation_id`, `operator_id`, `collected_by`, `chassis_id`, `started_at`, `paused_duration_seconds`, `completed_at`, `total_minutes` (plain column, not generated), `is_imported`, `team_id`, `production_line_id`, `created_at` | `total_minutes` is a normal writable column (unlike the old `stopwatch`/`operations` generated columns in 001/004), specifically so manual/imported averages can be saved without start/stop timestamps |
| `operation_time_notes` | `007`, renamed from `stopwatch_notes` (`004`) | `id`, `operation_time_id`, `content`, `created_by`, `created_at` | |

All 11 tables the brief asked about exist in the current schema. **None are missing.**

### Tables in the DB/code that are *not* in the requested schema list
- **`operator_change_requests`** (`004_new_schema.sql`) — operator team-transfer request/approval workflow. Fully wired: `src/app/config/ConfigClient.tsx` (submit tab), `src/app/admin/AdminClient.tsx` (approve/reject tab). Type in `src/lib/types.ts:40-53`.

### Tables defined but no longer live (superseded, dropped by later migrations)
- `tryout_sessions`, `work_centres`, `operator_work_centres`, `operation_templates`, the original `operations`/`notes` shapes (001–003) — all dropped by `004_new_schema.sql:13-20`.
- `stopwatch`, `stopwatch_notes`, and 004's `operations` shape — dropped by `007_v4_schema.sql:14-16`.

### RLS / policies
Every table has RLS enabled. Pattern is consistent: authenticated users can `SELECT` everything and `INSERT`/`UPDATE` most master data (jobs, operations, operators, products, teams, production_lines, model_operations); `DELETE` is admin-only everywhere (checked via a `profiles.role = 'admin'` subquery in the policy). `operation_times`/`operation_time_notes` restrict insert/update to the row's own `collected_by`/`created_by` (`auth.uid()`). `005_relax_config_insert_policies.sql` documents a specific fix: authenticated (non-admin) `INSERT` on `production_lines`/`teams`/`operators`/`products` was being rejected by RLS in production until this migration added permissive insert policies — the migration's own header says "review before applying, not run automatically," so its actual live-application status isn't verifiable from the repo alone (see Open Questions).

### CSV-import RPC functions vs. actual usage
`004_new_schema.sql:286-406` defines three Postgres functions — `import_operators`, `import_products`, `import_chassis` — each taking a `jsonb` array and doing an upsert. **`grep -rn "\.rpc(" src/` returns zero matches** — none of these functions are called anywhere in the app. The actual CSV import logic (see §5) is implemented client-side with direct `supabase.from(...).upsert(...)` calls that don't match these RPCs' column names (e.g. the RPCs still reference `products.code`/`products.name`, pre-dating the `007` rename to `product_code`/`model`). These three RPCs are dead/orphaned code relative to the current app and schema.

---

## 3. Auth

- Supabase Auth is wired up via `@supabase/ssr`: `src/lib/supabase/client.ts` (browser), `src/lib/supabase/server.ts` (server components, cookie-based), `src/lib/supabase/service.ts` (service-role client, bypasses RLS), `src/middleware.ts` (session refresh + route gating).
- **Sign-in only** — `src/app/login/page.tsx` calls `supabase.auth.signInWithPassword`. There is no sign-up form, no `supabase.auth.signUp`, no `admin.createUser`/`inviteUserByEmail` call anywhere in `src/` (`grep -rn "signUp\|inviteUserByEmail\|admin.createUser" src/` is empty). New users must be created outside the app (Supabase dashboard or direct API).
- `src/app/auth/callback/route.ts` handles a `code` query param via `exchangeCodeForSession` — an OAuth/magic-link code-exchange endpoint exists, but nothing in the login page actually triggers an OAuth or magic-link flow, so this route currently has no caller in-app either.
- **Profile creation on signup**: a DB trigger `handle_new_user()` (`001_initial_schema.sql:132-149`) inserts a `profiles` row on every `auth.users` insert, copying `full_name` from `raw_user_meta_data`. `004`'s header explicitly notes "`profiles` is untouched," so this trigger is presumed still active.
- **Self-heal for missing profiles**: `src/app/profile/page.tsx:18-33` — if a user has no `profiles` row (pre-dating the trigger, or any other gap), the profile page uses the service-role client to upsert one, since the anon/authenticated client can't insert into `profiles` (only `SELECT`/`UPDATE` policies exist for it).
- **Role/admin handling**: `profiles.role` is `'user' | 'admin'` (checked in the DB, `001_initial_schema.sql:12`).
  - `src/middleware.ts:49-62` redirects non-admins away from `/admin` and `/config`.
  - `src/app/admin/page.tsx:12-13` re-checks role server-side and redirects to `/dashboard` if not admin (defense in depth beyond the middleware).
  - `src/components/Nav.tsx:37-48` only renders the Config/Admin nav links for `role === 'admin'`.
  - `src/app/admin/AdminClient.tsx:26-29` lets an admin change another user's role via a `<select>`.
  - Admin "delete user" (`AdminClient.tsx:31-35`) only deletes the `profiles` row — it does not call any admin API to delete the underlying `auth.users` record, so the person can still authenticate afterward (see Known Gaps).

---

## 4. Screens / routes built

| Route | Status | What's actually there |
|---|---|---|
| `/dashboard` | **Fully built** | `DashboardClient.tsx` (450 lines) — line-scoped stat cards (coverage %, gaps remaining, times this week, active operators), a live gap list with an inline "add a time" drawer, quick links to Collect/Records/Analytics. All data-driven, no placeholders. |
| `/setup` | **Fully built** | `SetupClient.tsx` (320 lines) — 3-step flow: add a job, add an operation to a job (with primary/secondary operator), link an operation to models via checkboxes. |
| `/collect` | **Fully built** | `CollectClient.tsx` (730 lines) — the actual stopwatch tool. Two entry flows (Operator First / Chassis First), live running/paused timer cards with a 1s tick, pause/resume, complete with confirmation dialog, notes per running timer, "last timed" hint, ability to create a new operation inline, sibling-model checkbox linking. |
| `/validate` | **Fully built** | `ValidateClient.tsx` (402 lines) — operator's jobs × their operations × product-series coverage grid, drill-down drawer per operation/series to see/edit per-model average time. |
| `/gaps` | **Fully built** | `GapsClient.tsx` (559 lines) — 3 tabs: By Operator (missing operation×model pairs with a "last timed elsewhere" hint), By Model (operation coverage for one model), By Job (operation coverage with expandable per-model detail). |
| `/analytics` | **Fully built** | `AnalyticsClient.tsx` (384 lines) — takt-time inputs, operator table (total minutes vs. takt, coverage, status badge, bar chart via `recharts`), team summary, ERP output table (avg × units per operation with grand total). |
| `/records` | **Fully built** | `RecordsClient.tsx` (255 lines) — filterable list of completed `operation_times` (line/team/operator/product/date range), per-record PDF export via `src/lib/pdf.ts`. |
| `/config` | **Fully built** | `ConfigClient.tsx` (549 lines), admin-only — 5 tabs: Production Lines, Teams, Operators (+ CSV import), Products (+ CSV import), Change Requests (submit + implicitly view). |
| `/admin` | **Fully built** | `AdminClient.tsx` (179 lines), admin-only — Users (role change, delete), Operation Times (delete any record), Change Requests (approve/reject). |
| `/profile` | **Fully built** | `ProfileClient.tsx` (87 lines) — edit full name and preferred production line, read-only email. |
| `/login` | **Fully built** (sign-in only) | Email/password sign-in form. No sign-up, no password reset link, no OAuth buttons. |

No stubs, no "coming soon" placeholders, no commented-out page bodies were found anywhere in `src/app`. Every route above is a real, data-wired implementation — the gaps in this codebase are in business-rule completeness and data-entry coverage (see §7), not in unfinished screens.

---

## 5. Data import

- **CSV parsing**: `src/lib/csv.ts` — a small hand-rolled, quote-aware CSV parser (`parseCsv`), header row → array of `Record<string,string>`. Generic, not domain-specific.
- **Operators CSV import**: implemented in `src/app/config/ConfigClient.tsx:217-255` (`OperatorsTab.handleFile`). Reads the file, resolves `production_line_name`/`team_name` text columns to IDs by case-insensitive name match against already-loaded lines/teams, then:
  - Rows **with** an `employee_id` → `supabase.from('operators').upsert(withId, { onConflict: 'employee_id' })` — **the operator upsert-on-`employee_id` logic exists and is exactly this.**
  - Rows **without** an `employee_id` → plain `insert` (can't upsert without a natural key).
  - Rows missing `full_name` are skipped and counted.
- **Products CSV import**: `ConfigClient.tsx:370-402` (`ProductsTab.handleFile`) — upserts on `product_code`, maps `product_series`/`product_type`/`year`/`productionfacility`/`production_line_name`.
- **Chassis CSV import**: **not implemented anywhere in the UI.** `grep -rn "from('chassis')" src/` shows only two `SELECT` call sites (`CollectClient.tsx:426` and `:644`, both chassis-number lookups during timing) — no page inserts, upserts, or imports chassis rows. The `import_chassis` RPC exists in SQL (§2) but has no caller and, being unused, was never adapted to the `007` column rename either. Chassis data must currently be loaded by some process outside this app (direct DB write, or a tool not in this repo).

---

## 6. Business logic

- **Workload calc (primary + secondary, 50/50 split)**: `src/lib/takt.ts` — `operationWorkloadShare(hasPrimary, hasSecondary)` returns `0.5` if both are set, `1` otherwise; `isMasterOperation(jobName, operationName)` identifies a job's `"[Job Name] - Total"` master operation. Both are consumed in `src/app/analytics/AnalyticsClient.tsx` (operator takt table: `operatorRows` useMemo, and `teamSummary` useMemo) — operator/team totals are computed from each job's master operation only, with primary+secondary operations split 50/50 between the two operators. This is the **only** place in the app that currently does operator-level workload aggregation; `/dashboard`, `/gaps`, and the PDF export (§ below) don't compute a per-operator workload total today, so the split rule has nothing to apply to there yet.
- **Takt time**: computed twice, inconsistently:
  - `src/lib/takt.ts:4-7` — `calcTaktMinutes(availableHoursPerDay, dailyOrderCount)` — a proper helper.
  - `src/app/analytics/AnalyticsClient.tsx:154-158` — `taktMinutes` is recomputed **inline** (`availableMinutes / unitsPerDay`) rather than calling `calcTaktMinutes`. The lib helper is never imported by any page (`grep -rn "calcTaktMinutes" src/app/` is empty) — dead code.
  - Over/under flagging is also duplicated: `lib/takt.ts:9-24` has `flagOperator()` (uses a ±10% tolerance band around takt and a <50% coverage cutoff), but it too is unused — `AnalyticsClient.tsx:181-186` (`rowStatus`) reimplements the over/under decision inline with different thresholds (exact `>`/`<` comparison against takt, no tolerance band, and a <100% coverage cutoff for "incomplete" instead of <50%). The two implementations don't agree with each other.
- **Average time**: no shared helper — every page that needs an average (Validate, Gaps ×3 tabs, Analytics, Dashboard, Collect ×2 flows) re-implements the same `sum/count` reduction over `operation_times.total_minutes` locally. Functionally consistent (all average only rows with non-null `total_minutes`), but duplicated in at least 7 places rather than centralized.
- **Gaps report logic**: no single implementation — `GapsClient.tsx` (3 tabs, each with its own gap-finding query/reduction) and `DashboardClient.tsx:200-201` (global coverage stat) each independently compute "operation × model combos with no matching `operation_time`" via their own `model_operations` vs. `operation_time_models` diff. `OperatorAnalytics` (`src/lib/types.ts:172-179`) and `TaktFlag` look like they were meant to unify this but are never imported/used anywhere (`grep -rn "OperatorAnalytics" src/app/` is empty).

---

## 7. Known gaps / TODOs

No `TODO`/`FIXME`/`XXX`/`HACK` markers exist anywhere in `src/` (`grep -rn "TODO\|FIXME\|XXX\|HACK" src/` returns nothing) — gaps below were found by reading the code, not by markers left in it.

1. **No chassis data-entry path.** (§5) `chassis` is read-only from the app's perspective. Either an external tool populates it, or this is an unbuilt feature.
2. **Three orphaned SQL RPC functions** (`import_operators`, `import_products`, `import_chassis`, `004_new_schema.sql:286-406`) that no code calls, and that are stale against the `007` product column rename.
3. **Dead business-logic helpers**: `calcTaktMinutes`, `flagOperator` (`lib/takt.ts`), and the `OperatorAnalytics` type (`lib/types.ts:172-179`) are defined but unused — the pages that need this logic reimplement it inline with different thresholds instead (§6).
4. **Admin "delete user" is partial.** `AdminClient.tsx:31-35` deletes only the `profiles` row, not the `auth.users` record — the person keeps the ability to log in (and per §3's self-heal logic, `/profile` would silently recreate their profile row on next visit).
5. **`005_relax_config_insert_policies.sql`'s own header says "review before applying. Not run automatically."** — this repo can't confirm whether that policy fix is actually live in production; if it isn't, non-admin inserts on `production_lines`/`teams`/`operators`/`products` from `/config` would currently fail with a `42501` RLS error, matching the exact bug the migration describes.
6. **`007_v4_schema.sql`'s own header** similarly says "Do NOT run this against production" — it's a reference/reconstruction of a schema that was hand-migrated live, meaning this repo's migration folder is documentation of the DB, not a script that can rebuild it from `001` onward.
7. **Auth callback route has no in-app caller.** `/auth/callback` exists and works, but nothing in `/login` initiates an OAuth or magic-link flow that would hit it.
8. **Duplicated average/gap-finding logic** across ~7 call sites (§6) — not broken, but any future change to "what counts as timed" has to be made in every one of those places.
9. **No automated tests.** No test runner in `package.json`, no `__tests__`/`*.test.*`/`*.spec.*` files anywhere in the repo.

---

## 8. Open questions

- **Is `005_relax_config_insert_policies.sql` actually applied to production?** Its own comment says it's for review, not auto-run, and the repo has no migration-runner state to check against. Can't be determined from the code alone (see Gap #5).
- **Is `007_v4_schema.sql` a complete and accurate record of the live DB**, or only of the parts someone happened to hand-migrate and later document? Its header claims it was "verified via direct PostgREST introspection on 2026-08-03," which is the most recent authority in the repo, so this summary treats it as ground truth for the current schema — but it's a claim in a comment, not something this analysis could independently verify.
- **Intended flow for creating new users.** With no sign-up UI and no admin "invite user" action anywhere in the app, it's unclear from the code alone whether user provisioning is meant to happen entirely outside this app (Supabase dashboard), or whether an invite/signup feature was planned but never built.
- **Whether the `operator_change_requests` workflow is considered part of "J-Motion" or a separate feature layered on top** — it's fully built and wired into both Config and Admin, but wasn't in the schema list the brief named, so I flagged rather than assumed it either way.
- **Whether the three unused `import_*` RPCs and the two unused `lib/takt.ts` helpers are meant to be adopted by the client code (i.e., in-progress refactors) or are leftovers from an earlier implementation** — the code gives no signal either way; I've reported them as present-but-unused rather than guessing intent.
