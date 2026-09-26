-- PROPOSAL ONLY: do not apply until the operator approves the SQL.
-- The existing replacement and the audit entry run in one transaction.
CREATE OR REPLACE FUNCTION public.replace_pallet_plan_with_choice(
  p_order_id uuid,
  p_pallets jsonb,
  p_force boolean,
  p_actor_user_id uuid,
  p_audit jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_audit IS NULL
    OR jsonb_typeof(p_audit) <> 'object'
    OR coalesce(p_audit->>'selection', '') NOT IN ('keep', 'split')
    OR coalesce(p_audit->>'mode', '') NOT IN ('A', 'B', 'manual')
    OR coalesce(jsonb_typeof(p_audit->'corrections'), '') <> 'array'
    OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Dados de auditoria da paletização inválidos'
      USING ERRCODE = '22023';
  END IF;

  v_result := public.replace_pallet_plan_atomic(
    p_order_id, p_pallets, p_force, p_actor_user_id
  );

  INSERT INTO public.operation_history (
    entity_type, entity_id, action, performed_by, details
  ) VALUES (
    'order', p_order_id, 'pallet_plan_confirmed', p_actor_user_id,
    p_audit || jsonb_build_object(
      'total_pallets', v_result->'total_pallets',
      'total_boxes', v_result->'total_boxes',
      'saved_pallet_ids', (
        SELECT coalesce(jsonb_agg(p->'id' ORDER BY (p->>'pallet_number')::integer), '[]'::jsonb)
        FROM jsonb_array_elements(v_result->'pallets') AS p
      )
    )
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_pallet_plan_with_choice(uuid, jsonb, boolean, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_pallet_plan_with_choice(uuid, jsonb, boolean, uuid, jsonb)
  TO service_role;