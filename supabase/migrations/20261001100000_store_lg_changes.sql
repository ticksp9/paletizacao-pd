-- Mudanças de LG (pedido de 01/10): o Pingo Doce às vezes muda o LG de uma loja sem avisar.
-- Quando uma encomenda traz, para uma loja já conhecida, um LG diferente do conhecido, não se
-- pode emitir etiquetas nem criar o ficheiro até um administrador confirmar a mudança.
--
-- * store_lg_known: LG conhecido de cada loja (por armazém). Semeado com a encomenda mais
--   recente de cada loja. Os dados mestre (pd_lg_locations) NÃO servem para isto: para o
--   armazém 5531 já não batem certo com as encomendas.
-- * order_lg_mismatches(order): lojas da encomenda cujo LG é diferente do conhecido.
-- * confirm_order_lgs(order): só administrador; o LG da encomenda passa a ser o conhecido.
-- * learn_order_lgs(order): regista lojas novas (nunca vistas); não bloqueiam.
-- Alteração aditiva: nada existente é alterado.

CREATE TABLE IF NOT EXISTS public.store_lg_known (
  warehouse_code text NOT NULL,
  store_code text NOT NULL,
  lg_code text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid,
  source_order_id uuid,
  PRIMARY KEY (warehouse_code, store_code, lg_code)
);

ALTER TABLE public.store_lg_known ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated can view store_lg_known" ON public.store_lg_known;
CREATE POLICY "Authenticated can view store_lg_known" ON public.store_lg_known
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.store_lg_known FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.store_lg_known TO authenticated;
GRANT ALL ON TABLE public.store_lg_known TO service_role;

-- Lojas/LG de uma encomenda, normalizados (armazém da linha ou da encomenda; LG = "LG" + dígitos).
CREATE OR REPLACE FUNCTION public.order_store_lgs(p_order_id uuid)
RETURNS TABLE (warehouse_code text, store_code text, lg_code text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT
    coalesce(nullif(btrim(ol.warehouse_code), ''), nullif(btrim(o.store_code), ''), '') AS warehouse_code,
    btrim(ol.store_code) AS store_code,
    'LG' || regexp_replace(ol.lg_code, '\D', '', 'g') AS lg_code
  FROM public.order_lines ol
  JOIN public.orders o ON o.id = ol.order_id
  WHERE ol.order_id = p_order_id
    AND nullif(btrim(ol.store_code), '') IS NOT NULL
    AND regexp_replace(coalesce(ol.lg_code, ''), '\D', '', 'g') <> '';
$$;
REVOKE ALL ON FUNCTION public.order_store_lgs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_store_lgs(uuid) TO authenticated, service_role;

-- Semear: para cada loja, os LG da encomenda mais recente em que aparece.
INSERT INTO public.store_lg_known (warehouse_code, store_code, lg_code, source_order_id)
SELECT DISTINCT x.warehouse_code, x.store_code, x.lg_code, x.order_id
FROM (
  SELECT s.warehouse_code, s.store_code, s.lg_code, o.id AS order_id,
         rank() OVER (PARTITION BY s.warehouse_code, s.store_code ORDER BY o.created_at DESC, o.id) AS rk
  FROM public.orders o
  CROSS JOIN LATERAL public.order_store_lgs(o.id) s
) x
WHERE x.rk = 1
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.order_lg_mismatches(p_order_id uuid)
RETURNS TABLE (warehouse_code text, store_code text, order_lg text, known_lgs text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.warehouse_code, s.store_code, s.lg_code AS order_lg,
         (SELECT string_agg(k.lg_code, ', ' ORDER BY k.lg_code)
          FROM public.store_lg_known k
          WHERE k.warehouse_code = s.warehouse_code AND k.store_code = s.store_code) AS known_lgs
  FROM public.order_store_lgs(p_order_id) s
  WHERE EXISTS (
          SELECT 1 FROM public.store_lg_known k
          WHERE k.warehouse_code = s.warehouse_code AND k.store_code = s.store_code)
    AND NOT EXISTS (
          SELECT 1 FROM public.store_lg_known k
          WHERE k.warehouse_code = s.warehouse_code AND k.store_code = s.store_code AND k.lg_code = s.lg_code)
  ORDER BY s.store_code, s.lg_code;
$$;
REVOKE ALL ON FUNCTION public.order_lg_mismatches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_lg_mismatches(uuid) TO authenticated, service_role;

-- Lojas novas (nunca vistas): ficam registadas com o LG desta encomenda. Não mexe nas conhecidas.
CREATE OR REPLACE FUNCTION public.learn_order_lgs(p_order_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.store_lg_known (warehouse_code, store_code, lg_code, source_order_id)
  SELECT s.warehouse_code, s.store_code, s.lg_code, p_order_id
  FROM public.order_store_lgs(p_order_id) s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.store_lg_known k
    WHERE k.warehouse_code = s.warehouse_code AND k.store_code = s.store_code)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.learn_order_lgs(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.learn_order_lgs(uuid) TO service_role;

-- Administrador confirma que o LG novo desta encomenda está certo: passa a ser o conhecido.
CREATE OR REPLACE FUNCTION public.confirm_order_lgs(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_changes jsonb;
BEGIN
  IF v_actor IS NULL OR NOT private.has_role(v_actor, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Só um administrador pode confirmar a mudança de LG.';
  END IF;
  PERFORM 1 FROM public.orders o WHERE o.id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Encomenda não encontrada.'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'warehouse_code', m.warehouse_code, 'store_code', m.store_code,
           'old_lgs', m.known_lgs, 'new_lg', m.order_lg)), '[]'::jsonb)
  INTO v_changes
  FROM public.order_lg_mismatches(p_order_id) m;

  IF jsonb_array_length(v_changes) = 0 THEN
    RETURN jsonb_build_object('status', 'nothing_to_confirm', 'changes', 0);
  END IF;

  -- Para cada loja que mudou: sai o LG antigo, entram os LG desta encomenda.
  DELETE FROM public.store_lg_known k
  USING jsonb_array_elements(v_changes) c
  WHERE k.warehouse_code = c->>'warehouse_code' AND k.store_code = c->>'store_code';

  INSERT INTO public.store_lg_known (warehouse_code, store_code, lg_code, confirmed_by, source_order_id)
  SELECT s.warehouse_code, s.store_code, s.lg_code, v_actor, p_order_id
  FROM public.order_store_lgs(p_order_id) s
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_changes) c
    WHERE c->>'warehouse_code' = s.warehouse_code AND c->>'store_code' = s.store_code)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.operation_history (entity_type, entity_id, action, performed_by, details)
  VALUES ('order', p_order_id, 'lg_change_confirmed', v_actor, jsonb_build_object('changes', v_changes));

  RETURN jsonb_build_object('status', 'confirmed', 'changes', jsonb_array_length(v_changes));
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_order_lgs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_order_lgs(uuid) TO authenticated, service_role;
