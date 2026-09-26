-- Fase 3: criação da tabela, RLS e privilégios aprovados.
CREATE TABLE public.pallet_store_containers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  palletization_plan_id uuid NOT NULL
    REFERENCES public.palletization_plans(id) ON DELETE CASCADE,
  store_code text NOT NULL,
  lg_code text,
  soc_code text NOT NULL UNIQUE,
  total_boxes integer,
  created_at timestamptz DEFAULT now(),
  UNIQUE (palletization_plan_id, store_code)
);

-- Neste projeto, os privilégios por defeito dão ALL a anon e authenticated.
-- Retirar esses privilégios apenas da tabela acabada de criar antes dos GRANTs.
REVOKE ALL ON TABLE public.pallet_store_containers
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.pallet_store_containers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Active roles can view pallet_store_containers"
  ON public.pallet_store_containers
  FOR SELECT TO authenticated
  USING (
    private.has_role(auth.uid(), 'admin'::public.app_role)
    OR private.has_role(auth.uid(), 'operador'::public.app_role)
    OR private.has_role(auth.uid(), 'etiquetas'::public.app_role)
  );

CREATE POLICY "Operators and admins can write pallet_store_containers"
  ON public.pallet_store_containers
  FOR ALL TO authenticated
  USING (
    private.has_role(auth.uid(), 'admin'::public.app_role)
    OR private.has_role(auth.uid(), 'operador'::public.app_role)
  )
  WITH CHECK (
    private.has_role(auth.uid(), 'admin'::public.app_role)
    OR private.has_role(auth.uid(), 'operador'::public.app_role)
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.pallet_store_containers TO authenticated;
GRANT ALL
  ON public.pallet_store_containers TO service_role;