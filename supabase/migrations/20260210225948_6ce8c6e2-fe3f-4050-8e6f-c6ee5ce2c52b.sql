
-- Atomic sequence for SOC codes (SOC000001, SOC000002, …)
CREATE SEQUENCE IF NOT EXISTS public.soc_code_seq START 1 INCREMENT 1;

-- Helper function to generate next soc_code atomically
CREATE OR REPLACE FUNCTION public.generate_soc_code()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT 'SOC' || lpad(nextval('public.soc_code_seq')::text, 6, '0');
$$;
