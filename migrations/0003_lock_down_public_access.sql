-- Deny all direct API access to the payments database.
--
-- This database holds PAN, bank account numbers, the double-entry ledger and
-- statutory withholding records. It is reached by exactly one client: the
-- backend service, over a direct Postgres connection as the owning role.
-- Nothing should ever read it from a browser, so every table gets RLS enabled
-- with NO policies, which denies every non-owner role by default.
--
-- RLS is ENABLEd but deliberately not FORCEd: the owning role the backend
-- connects as must continue to bypass it. A "RLS enabled, no policy" lint on
-- these tables is the intended state, not an oversight.

-- Applied against the schema the migration is running in, not a hardcoded
-- "public": tests run in an isolated schema, and hardcoding would let this
-- lockdown silently no-op in exactly the place it should be exercised.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', current_schema(), t.tablename);
  END LOOP;
END $$;

-- Where the deployment target exposes a REST layer (Supabase and similar), its
-- API roles are revoked outright. Views default to the definer's rights and
-- would otherwise read straight through the RLS above, so the revoke matters
-- as much as the RLS does. Guarded by a role check so the same migration runs
-- unchanged against a plain Postgres, where these roles do not exist.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', current_schema(), api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', current_schema(), api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', current_schema(), api_role);
      EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', current_schema(), api_role);
      -- Anything added later inherits the same denial rather than silently
      -- opening up when a new table lands.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', current_schema(), api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', current_schema(), api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I', current_schema(), api_role);
    END IF;
  END LOOP;
END $$;
