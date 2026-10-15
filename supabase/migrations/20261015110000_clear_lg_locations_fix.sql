-- Correção (15/10): o Supabase recusa "DELETE" sem condição nos pedidos que vêm da aplicação
-- (proteção pg-safeupdate): "DELETE requires a WHERE clause". Acrescenta-se WHERE true a apagar
-- a lista inteira em clear_lg_locations e restore_lg_locations_backup. Nada mais muda.

CREATE OR REPLACE FUNCTION public.clear_lg_locations()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_backup uuid := gen_random_uuid();
  v_count integer;
BEGIN
  IF v_actor IS NULL OR NOT private.has_role(v_actor, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Só um administrador pode apagar os LG.';
  END IF;

  INSERT INTO public.pd_lg_locations_backup (backup_id, backed_up_by, row_data)
  SELECT v_backup, v_actor, to_jsonb(l) FROM public.pd_lg_locations l;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM public.pd_lg_locations WHERE true;

  -- Guarda só as 3 cópias mais recentes.
  DELETE FROM public.pd_lg_locations_backup b
  WHERE b.backup_id NOT IN (
    SELECT x.backup_id FROM (
      SELECT backup_id, max(backed_up_at) AS at FROM public.pd_lg_locations_backup GROUP BY backup_id
      ORDER BY at DESC LIMIT 3
    ) x
  );

  INSERT INTO public.operation_history (entity_type, entity_id, action, performed_by, details)
  VALUES ('pd_lg_locations', v_backup, 'lg_locations_cleared', v_actor,
          jsonb_build_object('deleted', v_count, 'backup_id', v_backup));

  RETURN jsonb_build_object('deleted', v_count, 'backup_id', v_backup);
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_lg_locations_backup()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_backup uuid;
  v_count integer;
BEGIN
  IF v_actor IS NULL OR NOT private.has_role(v_actor, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Só um administrador pode repor os LG.';
  END IF;
  SELECT backup_id INTO v_backup
  FROM public.pd_lg_locations_backup
  GROUP BY backup_id ORDER BY max(backed_up_at) DESC LIMIT 1;
  IF v_backup IS NULL THEN RAISE EXCEPTION 'Não há nenhuma cópia para repor.'; END IF;

  DELETE FROM public.pd_lg_locations WHERE true;
  INSERT INTO public.pd_lg_locations
  SELECT (jsonb_populate_record(NULL::public.pd_lg_locations, b.row_data)).*
  FROM public.pd_lg_locations_backup b
  WHERE b.backup_id = v_backup;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.operation_history (entity_type, entity_id, action, performed_by, details)
  VALUES ('pd_lg_locations', v_backup, 'lg_locations_restored', v_actor,
          jsonb_build_object('restored', v_count, 'backup_id', v_backup));

  RETURN jsonb_build_object('restored', v_count, 'backup_id', v_backup);
END;
$$;
