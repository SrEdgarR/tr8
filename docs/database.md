# Personal application database

The application uses `public.gr8r_projects` and `public.gr8r_tasks`. It does not
read or migrate the original demo's `localStorage` workspace. Preferences may
remain local; project/task data comes from Supabase.

## Access

Both tables have row-level security. Every policy requires the authenticated
user's ID to match `owner_id`, plus the private `gr8r_private.is_owner()` check.
That helper reads the current `auth.users` record, requires a confirmed email and
a non-deleted account,
and compares it to the administrative allowlist. It ignores user-editable JWT
metadata. The helper is the only `SECURITY DEFINER` function and has an empty
search path; all public RPCs use `SECURITY INVOKER` and obey RLS.

`gr8r_private.app_config` contains one row, with `owner_email = NULL` initially.
Until configured, every application account is denied. An administrator must
set `owner_email` to the lowercase confirmed account email through a trusted
database connection. Do not expose `gr8r_private` in Data API settings. The
browser receives only the publishable key, never privileged keys.

For local Auth callbacks, configure the project's Auth URL settings with Site URL
`http://127.0.0.1:5173` and these explicit Redirect URLs:

- `http://127.0.0.1:5173`
- `http://127.0.0.1:5173/?auth=recovery`
- `http://localhost:5173`
- `http://localhost:5173/?auth=recovery`

Keep email confirmation enabled and disable open signups for this personal app
after provisioning the owner. Account creation, confirmation and password setup
belong to Supabase Auth; never insert real passwords with SQL. Password recovery
must redirect to an allowed application URL and use Supabase's authenticated
recovery session. When a production hostname exists, add that exact HTTPS origin
and its recovery URL to Redirect URLs, then change Site URL to that HTTPS origin.
Avoid a broad wildcard for production and keep local URLs only while needed.

The client cannot read/change the allowlist, change an object's owner or parent,
forge timestamps/versions, set task numbers, or delete projects. Project removal
uses `archived_at`; tasks are readable while archived, but creation/editing is
rejected until the project is restored. Task deletion remains available.

## RPC contract

All names below are in `public`. Create/update calls return one composite row,
including server-managed fields; `gr8r_delete_task` returns void.

| Function              | Parameters                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gr8r_check_access`   | No arguments; returns boolean, not a composite row                                                                                                 |
| `gr8r_create_project` | `p_id uuid`, `p_name text`, `p_description text`, `p_color text`, `p_status text`                                                                  |
| `gr8r_create_task`    | `p_id uuid`, `p_project_id uuid`, `p_title text`, `p_description text`, `p_status text`, `p_priority text`, `p_start_date date`, `p_due_date date` |
| `gr8r_update_project` | `p_id uuid`, `p_version integer`, `p_patch jsonb`                                                                                                  |
| `gr8r_update_task`    | `p_id uuid`, `p_version integer`, `p_patch jsonb`                                                                                                  |
| `gr8r_delete_task`    | `p_id uuid`, `p_version integer`                                                                                                                   |

Create calls accept a client UUID as the request identity. Retry with that same
UUID and payload after an uncertain network outcome. A compatible existing row
is returned without inserting another; incompatible data returns `PT409`.
If the row has subsequently been edited, a retry of its original create payload
also conflicts; refresh to reconcile. Project codes derive from the UUID and are
unique per owner. Task numbers use a global `GENERATED ALWAYS AS IDENTITY`
sequence, not a client-side `MAX + 1`; gaps are expected. UUID collisions or the
very unlikely derived-code collision fail instead of overwriting another row.

Project patch keys: `name`, `description`, `color`, `status`, `archived_at`.
Task patch keys: `title`, `description`, `status`, `priority`, `start_date`,
`due_date`, `position`. Patches must be nonempty objects. Nullable dates/archive
values can be cleared with JSON null. Dates use `YYYY-MM-DD`; positions are
integers within JavaScript's safe range. Names are trimmed, project names are
1–120 characters, titles 1–500, descriptions at most 20,000. Color is six-digit
hex. Start dates cannot follow due dates. Statuses/priorities match `src/app/types.ts`.

Updates/deletes require the last read version. A successful update increments
the version in a trigger. Concurrent/stale writes receive `PT409`; missing or
invisible rows receive `PT404`. Do not retry stale changes silently. Other
relevant SQLSTATEs: `42501` unauthorized, `22023` invalid patch/input, `23514`
constraint violation, `23503` unavailable parent, `55000` archived project.

The authenticated role has minimal column grants needed by the invoker RPCs.
Direct table writes still obey RLS and validation, but expected-version checks
are an RPC contract: application updates/deletes must use these functions.
Archival and task writes are serialized by a parent row lock.

`src/app/data/database.generated.ts` contains the official public-schema types
generated from the hosted project. Regenerate it after schema changes. The
generator infers checked text statuses as `string` and currently emits date RPC
arguments as `string` even though PostgreSQL accepts null for optional dates;
keep the narrower domain types and an explicit nullable-date override when
adopting `SupabaseClient<Database>`. Generated-column metadata can mark `code`
nullable even though a nonnull UUID deterministically produces it.

## Verification

`supabase/tests/personal_app.sql` is a plain SQL assertion suite, executable as
`postgres` against a test database (SQL editor, MCP SQL execution, or `psql -v
ON_ERROR_STOP=1 -f ...`). It creates two fake confirmed users, temporarily changes
the private allowlist, switches to the real `anon` and `authenticated` roles,
and checks both allow and deny behavior, metadata spoofing, email confirmation,
ownership, validation, idempotent create retries, stale versions, deletion and
archival. All fixtures/config changes are wrapped in `BEGIN`/`ROLLBACK`.
Identity sequences consume values even on rollback; that only creates gaps.

The suite also verifies the identity definition and bulk allocates 128 task IDs
and numbers. This verifies server allocation/uniqueness, not simultaneous
connections. A separate integration test should issue two writes with the same
expected version and confirm that exactly one succeeds. Run security and
performance advisors after applying the migration. No tests should use real
passwords or print API keys.

Verification on the new hosted project passed all 74 assertions. The follow-up
cleanup query confirmed zero projects, tasks and fixture users, and an unchanged
empty allowlist. Security/performance advisors reported no warnings or errors:
only informational notices for the intentionally policy-free private config
table (administrative access only), and the composite FK index not yet used in
the empty database. Keep that index for future parent lookups/deletion checks.

The owner was then configured, created their account through the application,
confirmed their email and signed in with their own password. Open signups were
disabled after provisioning. Browser verification covered creating a project
and task, editing the task, changing state through the list selector and board
drag-and-drop, and recovering the persisted data after a full page reload.
Read-only SQL checks confirmed the saved rows and matching ownership. Anonymous
Data API requests to both tables returned HTTP 401. Password recovery has
automated form/session coverage and configured callbacks; its email and password
change flow has not been manually exercised with the owner's account.

References: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[database functions](https://supabase.com/docs/guides/database/functions),
[Auth redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
