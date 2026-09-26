CREATE TABLE IF NOT EXISTS public.pd_internal_article_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ean text NOT NULL,
  internal_code text NOT NULL,
  description text,
  source_filename text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pd_internal_article_codes_ean_digits CHECK (ean ~ '^[0-9]{4,14}$'),
  CONSTRAINT pd_internal_article_codes_internal_digits CHECK (internal_code ~ '^[0-9]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS pd_internal_article_codes_ean_active_idx
ON public.pd_internal_article_codes (ean)
WHERE active = true;

ALTER TABLE public.pd_internal_article_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view pd internal article codes" ON public.pd_internal_article_codes;
CREATE POLICY "Authenticated users can view pd internal article codes"
ON public.pd_internal_article_codes
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "Admins can manage pd internal article codes" ON public.pd_internal_article_codes;
CREATE POLICY "Admins can manage pd internal article codes"
ON public.pd_internal_article_codes
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP TRIGGER IF EXISTS update_pd_internal_article_codes_updated_at ON public.pd_internal_article_codes;
CREATE TRIGGER update_pd_internal_article_codes_updated_at
BEFORE UPDATE ON public.pd_internal_article_codes
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.warehouse_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_code text NOT NULL UNIQUE,
  warehouse_name text NOT NULL,
  address text NOT NULL,
  postcode text NOT NULL,
  city text NOT NULL,
  country text,
  source_filename text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_addresses_code_digits CHECK (warehouse_code ~ '^[0-9]+$')
);

ALTER TABLE public.warehouse_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view warehouse addresses" ON public.warehouse_addresses;
CREATE POLICY "Authenticated users can view warehouse addresses"
ON public.warehouse_addresses
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "Admins can manage warehouse addresses" ON public.warehouse_addresses;
CREATE POLICY "Admins can manage warehouse addresses"
ON public.warehouse_addresses
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP TRIGGER IF EXISTS update_warehouse_addresses_updated_at ON public.warehouse_addresses;
CREATE TRIGGER update_warehouse_addresses_updated_at
BEFORE UPDATE ON public.warehouse_addresses
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.warehouse_addresses (warehouse_code, warehouse_name, address, postcode, city, country, source_filename)
VALUES
  ('5531', 'PD - ALFENA N/P', 'Rua de Nossa Senhora do Amparo EM 6', '4440-000', 'Valongo', 'PT', 'Moradas entreposto.docx'),
  ('5405', 'PD – ALCOCHETE', 'Urb. Passil, Rua B nº 220-Lt-101ª', '2890-171', 'Alcochete', 'PT', 'Moradas entreposto.docx')
ON CONFLICT (warehouse_code) DO UPDATE SET
  warehouse_name = EXCLUDED.warehouse_name,
  address = EXCLUDED.address,
  postcode = EXCLUDED.postcode,
  city = EXCLUDED.city,
  country = EXCLUDED.country,
  source_filename = EXCLUDED.source_filename,
  active = true,
  updated_at = now();