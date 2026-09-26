-- Antes de aplicar, confirmar por consulta de leitura que não há soc_code duplicados
-- em public.palletization_plans e verificar last_value/is_called de soc_code_seq.
-- A sequência não é reiniciada nem avançada por esta migração.
CREATE OR REPLACE FUNCTION public.generate_soc_code() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE n bigint;
BEGIN
  n := nextval('public.soc_code_seq');
  IF n > 9999999 THEN RAISE EXCEPTION 'soc_code_seq ultrapassou 7 dígitos (%)', n; END IF;
  RETURN 'SOC' || lpad(n::text, 7, '0');
END $$;

REVOKE ALL ON FUNCTION public.generate_soc_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_soc_code() TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS palletization_plans_soc_code_unique_idx
  ON public.palletization_plans (soc_code)
  WHERE soc_code IS NOT NULL;