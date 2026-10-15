-- Apagar todos os LG / Lojas PD (pedido de 15/10): no início de cada mês o Pingo Doce muda
-- muitos LG; em vez de alterar um a um, apaga-se a lista e carrega-se o Excel novo.
-- Salvaguarda: antes de apagar guarda-se uma cópia completa; se o Excel novo falhar ou vier
-- incompleto, o administrador pode repor a lista anterior.
-- Alteração aditiva: só acrescenta uma tabela de cópias e duas funções (só administrador).

CREATE TABLE IF NOT EXISTS public.pd_lg_locations_backup (
  backup_id uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  backed_up_by uuid,
  row_data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pd_lg_locations_backup_id ON public.pd_lg_locations_backup (backup_id, backed_up_at);

ALTER TABLE public.pd_lg_locations_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pd_lg_locations_backup FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pd_lg_locations_backup TO service_role;

-- Apaga todos os LG, guardando antes uma cópia. Só administrador.
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

  DELETE FROM public.pd_lg_locations;

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
REVOKE ALL ON FUNCTION public.clear_lg_locations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_lg_locations() TO authenticated, service_role;

-- Informação da cópia mais recente (para mostrar o botão "Repor"). Só administrador.
CREATE OR REPLACE FUNCTION public.latest_lg_locations_backup()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT private.has_role(v_actor, 'admin'::public.app_role) THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object('backup_id', backup_id, 'backed_up_at', max(backed_up_at), 'rows', count(*))
  INTO v_result
  FROM public.pd_lg_locations_backup
  GROUP BY backup_id
  ORDER BY max(backed_up_at) DESC
  LIMIT 1;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.latest_lg_locations_backup() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.latest_lg_locations_backup() TO authenticated, service_role;

-- Repõe a lista da cópia mais recente (substitui o que estiver agora). Só administrador.
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

  DELETE FROM public.pd_lg_locations;
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
REVOKE ALL ON FUNCTION public.restore_lg_locations_backup() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_lg_locations_backup() TO authenticated, service_role;
