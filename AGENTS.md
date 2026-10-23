# TR8

The product name is **TR8** and its technical slug is **tr8**. Use these names for
the interface, package, repository, deployment projects and other platform
resources associated with this application. The intended future custom domain
is `tr8.studio`; do not treat it as purchased or configured until it is verified.

Preserve attribution and original upstream URLs. Applied migrations are immutable;
rename existing database objects through a new migration that preserves data,
RLS, grants, relationships and server-managed values. Compatibility code may
retain a legacy identifier only when needed to migrate existing user state.

Use npm and `package-lock.json`, with Node.js 22.12 or newer. Do not mix package
managers. Run typecheck, relevant tests, lint, format check and build before
publishing. Never commit local environment files or privileged Supabase keys.
