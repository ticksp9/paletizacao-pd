-- 1) Revoke over-broad grants
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.tablename);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', r.tablename);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.tablename);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon', r.sequencename);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated', r.sequencename);
    EXECUTE format('GRANT ALL ON SEQUENCE public.%I TO service_role', r.sequencename);
  END LOOP;
END $$;

-- 2) SECURITY DEFINER function execution
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_user_role(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bootstrap_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_role(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

-- 3) Storage: role-scoped policies
DROP POLICY IF EXISTS "Authenticated users can read exports" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read masterdata" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update exports" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload EDI files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload exports" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload labels" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload to masterdata" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view EDI files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view labels" ON storage.objects;

CREATE POLICY "ops_read_edi_masterdata" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id IN ('edi-files','masterdata')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador'))
);

CREATE POLICY "ops_write_edi_masterdata" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id IN ('edi-files','masterdata')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador'))
);

CREATE POLICY "ops_update_edi_masterdata" ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id IN ('edi-files','masterdata')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador'))
)
WITH CHECK (
  bucket_id IN ('edi-files','masterdata')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador'))
);

CREATE POLICY "labels_read" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id IN ('labels','exports')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador') OR public.has_role(auth.uid(),'etiquetas'))
);

CREATE POLICY "labels_write" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id IN ('labels','exports')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador') OR public.has_role(auth.uid(),'etiquetas'))
);

CREATE POLICY "labels_update" ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id IN ('labels','exports')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador') OR public.has_role(auth.uid(),'etiquetas'))
)
WITH CHECK (
  bucket_id IN ('labels','exports')
  AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operador') OR public.has_role(auth.uid(),'etiquetas'))
);

CREATE POLICY "admin_delete_files" ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id IN ('edi-files','masterdata','labels','exports')
  AND public.has_role(auth.uid(),'admin')
);