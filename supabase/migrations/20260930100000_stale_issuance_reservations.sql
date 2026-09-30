-- Reservas de emissão presas (erro de 30/09): ao emitir etiquetas/ficheiro o plano é
-- reservado; se a emissão falhava (ex.: encomenda sem paletes, ficheiro com erros) a reserva
-- ficava e depois não se conseguia fazer as paletes.
-- * cancel_plan_issuance: as funções libertam a sua reserva quando a emissão falha.
-- * replace_pallet_plan_atomic: reservas com mais de 10 minutos já não bloqueiam.
-- Alteração aditiva: nada existente é apagado (só reservas antigas, que já não servem).

CREATE OR REPLACE FUNCTION public.cancel_plan_issuance(p_order_id uuid, p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.pallet_plan_issuance_reservations r
  WHERE r.order_id = p_order_id AND r.token = p_token;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted > 0 THEN
    INSERT INTO public.operation_history (entity_type, entity_id, action, performed_by, details)
    VALUES ('order', p_order_id, 'plan_issuance_reservation_cancelled', NULL,
            jsonb_build_object('token', p_token));
  END IF;
  RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_plan_issuance(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_plan_issuance(uuid, uuid) TO service_role;

-- replace_pallet_plan_atomic: igual à versão de 20260929100000, mais a limpeza de reservas antigas.
CREATE OR REPLACE FUNCTION public.replace_pallet_plan_atomic(
  p_order_id uuid,
  p_pallets jsonb,
  p_force boolean DEFAULT false,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_force boolean := coalesce(p_force, false);
  v_has_labels boolean;
  v_has_desadv boolean;
  v_old_plans jsonb := '[]'::jsonb;
  v_old_labels jsonb := '[]'::jsonb;
  v_plan record;
  v_line record;
  v_box jsonb;
  v_store record;
  v_plan_id uuid;
  v_first_soc text;
  v_soc text;
  v_notes text;
  v_item_count integer;
  v_expected integer;
  v_total_boxes integer := 0;
  v_total_pallets integer;
  v_max_height integer;
  v_base_length integer;
  v_base_width integer;
  v_height integer;
  v_known_weight numeric;
  v_pieces integer;
  v_layers integer;
  v_lgs integer;
  v_stores integer;
  v_results jsonb := '[]'::jsonb;
  v_containers jsonb;
  v_box_socs jsonb;
  v_block text;
  v_single boolean;
  v_store_first_soc text;
  v_boxord record;
  v_item record;
BEGIN
  IF p_order_id IS NULL OR p_pallets IS NULL
     OR jsonb_typeof(p_pallets) <> 'array'
     OR jsonb_array_length(p_pallets) = 0
     OR jsonb_array_length(p_pallets) > 500
     OR octet_length(p_pallets::text) > 10000000 THEN
    RAISE EXCEPTION 'Invalid or out-of-bounds pallet plan';
  END IF;

  SELECT o.status::text INTO v_status
  FROM public.orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order % does not exist', p_order_id; END IF;
  SELECT EXISTS (SELECT 1 FROM public.labels l WHERE l.order_id = p_order_id)
         OR v_status = 'etiquetas_geradas'
  INTO v_has_labels;
  v_has_desadv := public.order_file_issued(p_order_id);

  -- Regra de alteração: entregue = fechada; ficheiro já gerado = só administrador.
  v_block := public.order_change_block_reason(p_order_id, p_actor_user_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block; END IF;

  -- Reservas com mais de 10 minutos são restos de emissões que falharam (uma emissão
  -- demora segundos): apagam-se e não bloqueiam. As recentes bloqueiam sempre.
  DELETE FROM public.pallet_plan_issuance_reservations r
  WHERE r.order_id = p_order_id AND r.reserved_at <= pg_catalog.now() - interval '10 minutes';
  IF EXISTS (
    SELECT 1 FROM public.pallet_plan_issuance_reservations r
    WHERE r.order_id = p_order_id
  ) THEN
    RAISE EXCEPTION 'An active issuance reservation prevents pallet-plan replacement';
  END IF;
  IF v_has_labels AND NOT v_force THEN
    RAISE EXCEPTION 'Generated labels require an explicitly forced pallet-plan replacement';
  END IF;
  IF v_force THEN
    IF p_actor_user_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = p_actor_user_id AND ur.role IN ('admin', 'operador')
    ) THEN
      RAISE EXCEPTION 'Forced replacement requires an admin or operator actor';
    END IF;
    IF v_has_labels THEN
      SELECT coalesce(jsonb_agg(
        jsonb_build_object(
          'pallet_number', p.pallet_number,
          'soc_code', p.soc_code,
          'lg_code', p.lg_code,
          'containers', coalesce(container_snapshot.container_details, '[]'::jsonb)
        ) ORDER BY p.pallet_number
      ), '[]'::jsonb)
      INTO v_old_plans
      FROM public.palletization_plans p
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'store_code', c.store_code, 'lg_code', c.lg_code,
          'soc_code', c.soc_code, 'total_boxes', c.total_boxes
        ) ORDER BY c.store_code) AS container_details
        FROM public.pallet_store_containers c
        WHERE c.palletization_plan_id = p.id
      ) container_snapshot ON true
      WHERE p.order_id = p_order_id;

      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'palletization_plan_id', l.palletization_plan_id,
        'label_type', l.label_type, 'pdf_storage_path', l.pdf_storage_path
      ) ORDER BY l.generated_at, l.id), '[]'::jsonb)
      INTO v_old_labels
      FROM public.labels l
      WHERE l.order_id = p_order_id;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.order_lines ol WHERE ol.order_id = p_order_id) THEN
    RAISE EXCEPTION 'Order has no lines';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_lines ol
    WHERE ol.order_id = p_order_id
      AND (NULLIF(btrim(ol.store_code), '') IS NULL
           OR btrim(ol.store_code) ~ '^0+$')
  ) THEN
    RAISE EXCEPTION 'Every order line must have a nonzero store code';
  END IF;

  v_total_pallets := jsonb_array_length(p_pallets);
  FOR v_plan IN
    SELECT value AS data, ordinality::integer AS ordinal
    FROM jsonb_array_elements(p_pallets) WITH ORDINALITY
  LOOP
    IF jsonb_typeof(v_plan.data) IS DISTINCT FROM 'object'
       OR v_plan.data->>'pallet_number' IS NULL
       OR (v_plan.data->>'pallet_number')::integer <> v_plan.ordinal
       OR jsonb_typeof(v_plan.data->'boxes') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_plan.data->'boxes') = 0
       OR jsonb_array_length(v_plan.data->'boxes') > 10000
       OR jsonb_typeof(v_plan.data->'warnings') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_plan.data->'is_mixed') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid pallet or non-consecutive pallet number at position %', v_plan.ordinal;
    END IF;
    v_total_boxes := v_total_boxes + jsonb_array_length(v_plan.data->'boxes');
    IF v_total_boxes > 10000 THEN RAISE EXCEPTION 'Plan exceeds 10000 boxes'; END IF;
  END LOOP;

  -- Every order line must contribute exactly the box count used by the builder.
  FOR v_line IN
    SELECT ol.id, ol.quantity, ol.quantity_cases, ol.article_code,
           ol.lg_code, ol.store_code,
           greatest(1, coalesce(nullif(a.pieces_per_box, 0), 1)) AS pieces_per_box
    FROM public.order_lines ol
    LEFT JOIN LATERAL (
      SELECT a.pieces_per_box
      FROM public.articles a
      WHERE a.code = ol.article_code OR a.ean = ol.article_code
      ORDER BY (a.code = ol.article_code) DESC, a.id
      LIMIT 1
    ) a ON true
    WHERE ol.order_id = p_order_id
  LOOP
    v_expected := CASE
      WHEN v_line.quantity_cases > 0 THEN ceil(v_line.quantity_cases)::integer
      ELSE greatest(1, ceil(v_line.quantity::numeric / v_line.pieces_per_box)::integer)
    END;
    IF v_expected < 1 OR v_expected > 10000 THEN
      RAISE EXCEPTION 'Invalid expected box count for order line %', v_line.id;
    END IF;
    SELECT count(*)::integer INTO v_item_count
    FROM jsonb_array_elements(p_pallets) p(value)
    CROSS JOIN LATERAL jsonb_array_elements(p.value->'boxes') b(value)
    WHERE b.value->>'order_line_id' = v_line.id::text;
    IF v_item_count <> v_expected THEN
      RAISE EXCEPTION 'Order line % requires % boxes, received %',
        v_line.id, v_expected, v_item_count;
    END IF;
  END LOOP;

  -- Validate each box against its order line and its pallet's base/height.
  FOR v_plan IN
    SELECT value AS data, ordinality::integer AS ordinal
    FROM jsonb_array_elements(p_pallets) WITH ORDINALITY
  LOOP
    CASE v_plan.data->>'pallet_size'
      WHEN '60x80' THEN
        v_base_length := 800; v_base_width := 600; v_max_height := 1250;
      WHEN '120x80' THEN
        v_base_length := 1200; v_base_width := 800; v_max_height := 1800;
      WHEN '120x100' THEN
        v_base_length := 1200; v_base_width := 1000; v_max_height := 1800;
      ELSE RAISE EXCEPTION 'Unsupported pallet size at pallet %', v_plan.ordinal;
    END CASE;
    IF coalesce((v_plan.data->>'base_length_mm')::integer, -1) <> v_base_length
       OR coalesce((v_plan.data->>'base_width_mm')::integer, -1) <> v_base_width
       OR coalesce((v_plan.data->>'base_usage_pct')::numeric, -1) NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'Invalid pallet base or usage at pallet %', v_plan.ordinal;
    END IF;

    v_height := 0;
    v_known_weight := 0;
    v_pieces := 0;
    FOR v_box IN SELECT value FROM jsonb_array_elements(v_plan.data->'boxes')
    LOOP
      IF jsonb_typeof(v_box) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_box->'store_code') <> 'string'
         OR NULLIF(btrim(v_box->>'store_code'), '') IS NULL
         OR btrim(v_box->>'store_code') ~ '^0+$'
         OR coalesce((v_box->>'pos_x_mm')::integer, -1) < 0
         OR coalesce((v_box->>'pos_y_mm')::integer, -1) < 0
         OR coalesce((v_box->>'pos_z_mm')::integer, -1) < 0
         OR coalesce((v_box->>'box_length_mm')::integer, 0) <= 0
         OR coalesce((v_box->>'box_width_mm')::integer, 0) <= 0
         OR coalesce((v_box->>'box_height_mm')::integer, 0) <= 0
         OR coalesce((v_box->>'box_length_mm')::integer, 5001) > 5000
         OR coalesce((v_box->>'box_width_mm')::integer, 5001) > 5000
         OR coalesce((v_box->>'box_height_mm')::integer, 5001) > 5000
         OR (v_box->>'pos_x_mm')::integer + (v_box->>'box_length_mm')::integer > v_base_length
         OR (v_box->>'pos_y_mm')::integer + (v_box->>'box_width_mm')::integer > v_base_width THEN
        RAISE EXCEPTION 'Invalid box dimensions, placement, or store on pallet %', v_plan.ordinal;
      END IF;
      SELECT ol.id, ol.article_code, ol.lg_code, ol.store_code,
             greatest(1, coalesce(nullif(a.pieces_per_box, 0), 1)) AS pieces_per_box,
             a.weight_kg
      INTO v_line
      FROM public.order_lines ol
      LEFT JOIN LATERAL (
        SELECT a.pieces_per_box, a.weight_kg
        FROM public.articles a
        WHERE a.code = ol.article_code OR a.ean = ol.article_code
        ORDER BY (a.code = ol.article_code) DESC, a.id
        LIMIT 1
      ) a ON true
      WHERE ol.id = (v_box->>'order_line_id')::uuid AND ol.order_id = p_order_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Box references a line outside this order'; END IF;
      IF v_box->>'article_code' IS DISTINCT FROM v_line.article_code
         OR btrim(v_box->>'store_code') IS DISTINCT FROM btrim(v_line.store_code)
         OR v_box->>'lg_code' IS DISTINCT FROM v_line.lg_code
         OR coalesce((v_box->>'quantity')::integer, -1) <> v_line.pieces_per_box
         OR coalesce((v_box->>'layer_number')::integer, 0) < 1
         OR coalesce((v_box->>'layer_number')::integer, 0) >
            coalesce((v_plan.data->>'total_layers')::integer, 0) THEN
        RAISE EXCEPTION 'Box metadata does not match order line %', v_line.id;
      END IF;
      IF v_box->>'placement_sequence' IS NOT NULL
         AND (
           jsonb_typeof(v_box->'placement_sequence') IS DISTINCT FROM 'number'
           OR (v_box->>'placement_sequence')::integer < 1
         ) THEN
        RAISE EXCEPTION 'Invalid placement sequence on pallet %', v_plan.ordinal;
      END IF;
      v_height := greatest(v_height,
        (v_box->>'pos_z_mm')::integer + (v_box->>'box_height_mm')::integer + 150);
      v_pieces := v_pieces + (v_box->>'quantity')::integer;
      IF v_line.weight_kg IS NOT NULL THEN
        v_known_weight := v_known_weight + v_line.weight_kg;
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_plan.data->'boxes') b(value)
      WHERE b.value->>'placement_sequence' IS NOT NULL
      GROUP BY (b.value->>'layer_number')::integer,
               (b.value->>'placement_sequence')::integer
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Duplicate placement sequence on pallet %', v_plan.ordinal;
    END IF;
    SELECT count(DISTINCT (b.value->>'layer_number')::integer)::integer
    INTO v_layers
    FROM jsonb_array_elements(v_plan.data->'boxes') b(value);
    IF v_height > v_max_height
       OR coalesce((v_plan.data->>'height_mm')::integer, -1) <> v_height
       OR coalesce((v_plan.data->>'total_layers')::integer, 0) <> v_layers
       OR coalesce((v_plan.data->>'total_pieces')::integer, -1) <> v_pieces THEN
      RAISE EXCEPTION 'Invalid pallet totals or hard height limit exceeded on pallet %', v_plan.ordinal;
    END IF;
    IF (v_plan.data->>'pallet_size') = '120x80' AND v_known_weight > 1000
       OR (v_plan.data->>'pallet_size') = '60x80' AND v_known_weight > 500 THEN
      RAISE EXCEPTION 'Known pallet weight exceeds limit on pallet %', v_plan.ordinal;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_plan.data->'boxes') WITH ORDINALITY a(value, n)
      JOIN jsonb_array_elements(v_plan.data->'boxes') WITH ORDINALITY b(value, n)
        ON a.n < b.n
      WHERE (a.value->>'pos_x_mm')::integer < (b.value->>'pos_x_mm')::integer + (b.value->>'box_length_mm')::integer
        AND (a.value->>'pos_x_mm')::integer + (a.value->>'box_length_mm')::integer > (b.value->>'pos_x_mm')::integer
        AND (a.value->>'pos_y_mm')::integer < (b.value->>'pos_y_mm')::integer + (b.value->>'box_width_mm')::integer
        AND (a.value->>'pos_y_mm')::integer + (a.value->>'box_width_mm')::integer > (b.value->>'pos_y_mm')::integer
        AND (a.value->>'pos_z_mm')::integer < (b.value->>'pos_z_mm')::integer + (b.value->>'box_height_mm')::integer
        AND (a.value->>'pos_z_mm')::integer + (a.value->>'box_height_mm')::integer > (b.value->>'pos_z_mm')::integer
    ) THEN
      RAISE EXCEPTION 'Overlapping boxes on pallet %', v_plan.ordinal;
    END IF;
  END LOOP;

  -- All checks precede deletion. Any later exception rolls back every write.
  IF v_force AND v_has_labels THEN
    DELETE FROM public.labels WHERE order_id = p_order_id;
  END IF;
  DELETE FROM public.pallet_items i USING public.palletization_plans p
  WHERE i.palletization_plan_id = p.id AND p.order_id = p_order_id;
  DELETE FROM public.pallet_store_containers c USING public.palletization_plans p
  WHERE c.palletization_plan_id = p.id AND p.order_id = p_order_id;
  DELETE FROM public.palletization_plans WHERE order_id = p_order_id;

  FOR v_plan IN
    SELECT value AS data, ordinality::integer AS ordinal
    FROM jsonb_array_elements(p_pallets) WITH ORDINALITY
  LOOP
    v_containers := '[]'::jsonb;
    v_box_socs := '{}'::jsonb;
    v_first_soc := NULL;
    SELECT count(DISTINCT NULLIF(b.value->>'lg_code', ''))::integer,
           count(DISTINCT btrim(b.value->>'store_code'))::integer
    INTO v_lgs, v_stores
    FROM jsonb_array_elements(v_plan.data->'boxes') b(value);
    -- Palete completa (definida pelo administrador): uma só loja, 1 SOC e 1 etiqueta.
    v_single := coalesce((v_plan.data->>'single_label')::boolean, false);
    IF v_single AND v_stores <> 1 THEN
      RAISE EXCEPTION 'A palete completa % tem de ter uma só loja', v_plan.ordinal;
    END IF;
    -- Match the builder's mixed-pallet notes without trusting client-supplied notes.
    IF v_lgs > 1 OR v_stores > 1 THEN
      SELECT jsonb_build_object(
        'type', 'mixed',
        'lg_codes', coalesce((
          SELECT jsonb_agg(x.lg_code ORDER BY x.first_ord)
          FROM (
            SELECT b.value->>'lg_code' AS lg_code, min(b.ordinality) AS first_ord
            FROM jsonb_array_elements(v_plan.data->'boxes')
              WITH ORDINALITY b(value, ordinality)
            WHERE nullif(b.value->>'lg_code', '') IS NOT NULL
            GROUP BY b.value->>'lg_code'
          ) x
        ), '[]'::jsonb),
        'store_codes', coalesce((
          SELECT jsonb_agg(x.store_code ORDER BY x.first_ord)
          FROM (
            SELECT btrim(b.value->>'store_code') AS store_code,
                   min(b.ordinality) AS first_ord
            FROM jsonb_array_elements(v_plan.data->'boxes')
              WITH ORDINALITY b(value, ordinality)
            GROUP BY btrim(b.value->>'store_code')
          ) x
        ), '[]'::jsonb)
      )::text INTO v_notes;
    ELSE
      v_notes := NULL;
    END IF;

    FOR v_store IN
      SELECT btrim(b.value->>'store_code') AS store_code,
             count(*)::integer AS total_boxes,
             CASE WHEN count(DISTINCT NULLIF(btrim(b.value->>'lg_code'), '')) = 1
                  THEN min(NULLIF(btrim(b.value->>'lg_code'), '')) END AS lg_code,
             coalesce(max(substring(b.value->>'lg_code' FROM '[0-9]+')::integer), -1) AS lg_num
      FROM jsonb_array_elements(v_plan.data->'boxes') b(value)
      GROUP BY btrim(b.value->>'store_code')
       ORDER BY lg_num DESC, btrim(b.value->>'store_code') COLLATE "C" ASC
    LOOP
      -- Um SOC por caixa, pela ordem de impressão das etiquetas (LG decrescente,
      -- loja, camada, sequência de colocação). O contentor da loja fica com o
      -- SOC da primeira caixa dessa loja nesta palete (compatibilidade).
      v_store_first_soc := NULL;
      IF v_single THEN
        v_soc := public.generate_soc_code();
        v_store_first_soc := v_soc;
        IF v_first_soc IS NULL THEN v_first_soc := v_soc; END IF;
      ELSE
      FOR v_boxord IN
        SELECT b.ordinality::integer AS ord
        FROM jsonb_array_elements(v_plan.data->'boxes') WITH ORDINALITY b(value, ordinality)
        WHERE btrim(b.value->>'store_code') = v_store.store_code
        ORDER BY (b.value->>'layer_number')::integer,
                 coalesce((b.value->>'placement_sequence')::integer, 2147483647),
                 b.ordinality
      LOOP
        v_soc := public.generate_soc_code();
        v_box_socs := v_box_socs || jsonb_build_object(v_boxord.ord::text, v_soc);
        IF v_store_first_soc IS NULL THEN v_store_first_soc := v_soc; END IF;
        IF v_first_soc IS NULL THEN v_first_soc := v_soc; END IF;
      END LOOP;
      END IF;
      v_containers := v_containers || jsonb_build_array(jsonb_build_object(
        'store_code', v_store.store_code, 'lg_code', v_store.lg_code,
        'soc_code', v_store_first_soc, 'total_boxes', v_store.total_boxes
      ));
    END LOOP;

    INSERT INTO public.palletization_plans (
      order_id, pallet_number, total_boxes, soc_code, lg_code, pallet_size,
      base_length_mm, base_width_mm, height_mm, total_layers, total_pieces,
      is_mixed, base_usage_pct, warnings, notes, single_label
    ) VALUES (
      p_order_id, v_plan.ordinal, jsonb_array_length(v_plan.data->'boxes'),
      v_first_soc,
      CASE WHEN v_lgs = 1 THEN (
        SELECT min(NULLIF(b.value->>'lg_code', ''))
        FROM jsonb_array_elements(v_plan.data->'boxes') b(value)
      ) END,
      v_plan.data->>'pallet_size',
      (v_plan.data->>'base_length_mm')::integer,
      (v_plan.data->>'base_width_mm')::integer,
      (v_plan.data->>'height_mm')::integer,
      (v_plan.data->>'total_layers')::integer,
      (v_plan.data->>'total_pieces')::integer,
      (v_lgs > 1 OR v_stores > 1),
      (v_plan.data->>'base_usage_pct')::numeric,
      coalesce(v_plan.data->'warnings', '[]'::jsonb),
      v_notes,
      v_single
    ) RETURNING id INTO v_plan_id;

    INSERT INTO public.pallet_store_containers
      (palletization_plan_id, store_code, lg_code, soc_code, total_boxes)
    SELECT v_plan_id, c->>'store_code', c->>'lg_code', c->>'soc_code',
           (c->>'total_boxes')::integer
    FROM jsonb_array_elements(v_containers) c;

    FOR v_item IN
      SELECT value AS box, ordinality::integer AS ord
      FROM jsonb_array_elements(v_plan.data->'boxes') WITH ORDINALITY
    LOOP
      v_box := v_item.box;
      IF NOT v_single AND NULLIF(v_box_socs->>(v_item.ord::text), '') IS NULL THEN
        RAISE EXCEPTION 'SOC em falta para a caixa % da palete %', v_item.ord, v_plan.ordinal;
      END IF;
      INSERT INTO public.pallet_items (
        palletization_plan_id, order_line_id, quantity, box_number,
        layer_number, pos_x_mm, pos_y_mm, pos_z_mm, box_length_mm,
        box_width_mm, box_height_mm, rotated, orientation, article_code,
        store_code, lg_code, placement_sequence, soc_code
      ) VALUES (
        v_plan_id, (v_box->>'order_line_id')::uuid, (v_box->>'quantity')::integer, 1,
        (v_box->>'layer_number')::integer, (v_box->>'pos_x_mm')::integer,
        (v_box->>'pos_y_mm')::integer, (v_box->>'pos_z_mm')::integer,
        (v_box->>'box_length_mm')::integer, (v_box->>'box_width_mm')::integer,
        (v_box->>'box_height_mm')::integer, (v_box->>'rotated')::boolean,
        v_box->>'orientation', v_box->>'article_code', btrim(v_box->>'store_code'),
        v_box->>'lg_code', (v_box->>'placement_sequence')::integer,
        CASE WHEN v_single THEN NULL ELSE v_box_socs->>(v_item.ord::text) END
      );
    END LOOP;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_plan_id, 'pallet_number', v_plan.ordinal,
      'soc_code', v_first_soc,
      'single_label', v_single,
      'total_boxes', jsonb_array_length(v_plan.data->'boxes'),
      'containers', v_containers
    ));
  END LOOP;

  UPDATE public.orders
  SET status = 'paletizado', total_pallets = v_total_pallets
  WHERE id = p_order_id;

  IF v_force AND v_has_labels THEN
    INSERT INTO public.operation_history (
      entity_type, entity_id, action, performed_by, details
    ) VALUES (
      'order', p_order_id, 'pallet_plan_replaced_after_labels',
      p_actor_user_id,
      jsonb_build_object(
        'old_status', v_status,
        'old_plans_store_soc_snapshot', v_old_plans,
        'old_label_ids_and_paths', v_old_labels,
        'new_soc_details', v_results,
        'new_labels', '[]'::jsonb
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'order_id', p_order_id, 'total_pallets', v_total_pallets,
    'total_boxes', v_total_boxes, 'pallets', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.replace_pallet_plan_atomic(uuid, jsonb, boolean, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_pallet_plan_atomic(uuid, jsonb, boolean, uuid)
  TO service_role;
