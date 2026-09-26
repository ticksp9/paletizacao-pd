
-- Table for PD / LG locations (store master data)
CREATE TABLE public.pd_lg_locations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT '01',
  location_id TEXT NOT NULL,
  lg_number TEXT NOT NULL,
  store_code TEXT,
  city_label TEXT,
  customer_label TEXT,
  name TEXT,
  delivery_internal_code TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Unique constraint for upsert by (company_id, location_id)
CREATE UNIQUE INDEX idx_pd_lg_locations_company_location ON public.pd_lg_locations (company_id, location_id);

-- Index for fast lookup by lg_number
CREATE INDEX idx_pd_lg_locations_lg_number ON public.pd_lg_locations (lg_number);

-- Enable RLS
ALTER TABLE public.pd_lg_locations ENABLE ROW LEVEL SECURITY;

-- Admins can manage
CREATE POLICY "Admins can manage pd_lg_locations"
ON public.pd_lg_locations
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- Authenticated users can view
CREATE POLICY "Authenticated users can view pd_lg_locations"
ON public.pd_lg_locations
FOR SELECT
USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_pd_lg_locations_updated_at
BEFORE UPDATE ON public.pd_lg_locations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
