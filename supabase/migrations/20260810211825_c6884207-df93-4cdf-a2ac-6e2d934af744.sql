-- 1. Private schema for internal, RLS-support functions (not exposed via the API)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- Move has_role out of the exposed public schema.
-- Existing RLS policies reference the function by OID, so they keep working.
ALTER FUNCTION public.has_role(uuid, public.app_role) SET SCHEMA private;

REVOKE ALL ON FUNCTION private.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.has_role(uuid, public.app_role) TO authenticated, service_role;

-- 2. Remove leftover execute grants on helper functions in the exposed schema
REVOKE ALL ON FUNCTION public.generate_soc_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_soc_code() TO service_role;

REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;

-- 3. Block GraphQL discovery for anon and authenticated
REVOKE USAGE ON SCHEMA graphql_public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA graphql_public FROM PUBLIC, anon, authenticated;
REVOKE USAGE ON SCHEMA graphql FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA graphql FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA graphql FROM PUBLIC, anon, authenticated;