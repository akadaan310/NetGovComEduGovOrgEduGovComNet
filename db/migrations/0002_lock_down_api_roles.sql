-- Deny all access to ACSP tables except through the application.
--
-- Hosted Postgres platforms such as Supabase expose tables in the `public`
-- schema over an auto-generated REST API (roles `anon` and `authenticated`,
-- reachable with the publishable key). If that API could read or write these
-- tables, anyone could bypass the protocol: forge events, read capability
-- hashes, or skip authority checks.
--
-- 1. Row-level security is enabled with NO policies, so non-owner roles see
--    and change nothing. The application connects as the table owner, which
--    RLS does not restrict.
-- 2. Any grants held by the API roles are revoked, including default
--    privileges on tables created later by this role.
-- On a plain Postgres without these roles, step 2 does nothing.

do $$
declare
  t text;
  r text;
begin
  foreach t in array array[
    'resources', 'events', 'toks', 'annotations', 'checkpoints', 'capabilities',
    'handoffs', 'proposals', 'idempotency', 'rate_limits', 'schema_migrations'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array[
        'resources', 'events', 'toks', 'annotations', 'checkpoints', 'capabilities',
        'handoffs', 'proposals', 'idempotency', 'rate_limits', 'schema_migrations'
      ] loop
        execute format('revoke all on table %I from %I', t, r);
      end loop;
      execute format('alter default privileges revoke all on tables from %I', r);
      execute format('alter default privileges revoke all on sequences from %I', r);
      execute format('alter default privileges revoke all on functions from %I', r);
      execute format('revoke execute on function acsp_forbid_history_mutation() from %I', r);
    end if;
  end loop;
end
$$;
