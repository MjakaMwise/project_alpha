# Casini central database

Target: **casini**, project `otbigsimwwlnuwkigehv`.
Dashboard: https://supabase.com/dashboard/project/otbigsimwwlnuwkigehv

The desktop/server Rust backend supports PostgreSQL through `CUSTOMIZE_DATABASE_URL`.
If the variable is absent it uses the existing SQLite database. If it is set but
invalid or unreachable, startup fails instead of silently writing to SQLite.
The desktop binary loads `.env` before starting; environment variables take precedence.
Android retains embedded SQLite for offline use. Android data is not automatically
synchronized with the central server by this change.

## Rollout

1. Stop app servers that write to the source SQLite database. Do not restart them
   until the import and cutover are complete; a snapshot cannot include later writes.
2. In the Casini dashboard's Connect dialog, copy the exact server-side PostgreSQL
   URL. Use session pooling on port 5432 if the server only supports IPv4. Copy
   `.env.example` to `.env` and replace its placeholder URL. URL-encode special
   characters in the password. Keep this file and all credentials on the server.
   Verified TLS is enforced by the Rust driver and import script. If required,
   download the project's CA and add `sslrootcert=/absolute/path/to/ca.crt` to the URL.
3. Apply `supabase/migrations/202611160001_initial.sql` once using the dashboard SQL
   editor or a database-owner connection. The remote tool call in this session was
   cancelled; the remote `customize` schema was confirmed empty afterward.
4. Import the existing database **before first starting the PostgreSQL backend**.
   The backend seeds its catalog on first startup; the importer intentionally
   refuses to overwrite any nonempty destination table.

   With `CUSTOMIZE_DATABASE_URL` exported in the shell (the Python script does not
   read `.env`), run:

   ```bash
   python3 scripts/import_sqlite.py --source data/customize.db
   ```

   Requires `psql`. This creates a consistent, private SQLite backup, normalizes
   email case, rejects duplicate emails, imports all nine tables in one transaction,
   preserves IDs, resets identity sequences, and verifies row counts. Any import
   failure rolls back the transaction. Password hashes and sessions are preserved;
   the app continues using its existing authentication rather than Supabase Auth.
5. Start the Rust server with `cargo run` or `./dev.sh -w`. Verify signup, login,
   logout, admin authorization, catalog edits, saved items, checkout and tracking
   before moving live traffic. All devices must use this same hosted Rust backend
   to share accounts and orders. A separately deployed HTTPS backend and Android
   API routing are needed for the APK to share central data.
6. Check Supabase security/performance advisors after the live migration. App tables
   are in the private `customize` schema with RLS enabled and browser roles denied
   table/schema access. No browser-facing privileged RPC or service key is added.

Uploads remain on the Rust server filesystem. Back them up alongside the database.
Room photos and cart contents stored on a device remain on that device.

## Verification

`cargo test --offline`: 26 passed, 1 integration test ignored. The schema and current
SQLite dataset were also imported successfully into local PostgreSQL 18 in single-user
mode, with row counts and identity sequence resets checked. Network sockets are
restricted in this environment, so no live PostgreSQL HTTP roundtrip was claimed.

For the complete integration test, apply the schema to an **empty disposable**
PostgreSQL database, set `CUSTOMIZE_TEST_DATABASE_URL` with verified TLS, and run:

```bash
cargo test postgres_central_database_roundtrip -- --ignored --test-threads=1
```

The integration test writes fixture users/orders and must never target production.
It checks login/logout, duplicate signup, authorization, saved items, idempotent
checkout, filtered admin queries and visibility through two independent app connections.

Connection reference: https://supabase.com/docs/guides/database/connecting-to-postgres
