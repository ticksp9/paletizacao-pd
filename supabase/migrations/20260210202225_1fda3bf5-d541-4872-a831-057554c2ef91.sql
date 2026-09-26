-- Create delivery_sites table for proper city/label mapping
CREATE TABLE public.delivery_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_code text NOT NULL UNIQUE,
  label_name text NOT NULL,
  city text NOT NULL,
  address text,
  postal_code text,
  active boolean DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.delivery_sites ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Authenticated users can view delivery_sites"
ON public.delivery_sites FOR SELECT
USING (true);

CREATE POLICY "Admins can manage delivery_sites"
ON public.delivery_sites FOR ALL
USING (has_role(auth.uid(), 'admin'));

-- Add trigger for updated_at
CREATE TRIGGER update_delivery_sites_updated_at
BEFORE UPDATE ON public.delivery_sites
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add delivery_site_id to orders table
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS delivery_site_id uuid REFERENCES public.delivery_sites(id);

-- Create label_jobs table to track label generation
CREATE TABLE public.label_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  pdf_storage_path text,
  labels_count integer DEFAULT 0,
  error_message text,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  created_by uuid
);

-- Enable RLS
ALTER TABLE public.label_jobs ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Authenticated users can view label_jobs"
ON public.label_jobs FOR SELECT
USING (true);

CREATE POLICY "Authenticated users can manage label_jobs"
ON public.label_jobs FOR ALL
USING (true);

-- Insert some sample delivery sites
INSERT INTO public.delivery_sites (internal_code, label_name, city, address, postal_code) VALUES
('BRG001', 'Centro Logístico Braga', 'Braga', 'Zona Industrial de Braga', '4700-000'),
('PRT001', 'Armazém Porto', 'Porto', 'Zona Industrial de Maia', '4470-000'),
('LSB001', 'Hub Lisboa', 'Lisboa', 'Parque Industrial de Loures', '2670-000'),
('CBR001', 'Depósito Coimbra', 'Coimbra', 'Zona Industrial de Taveiro', '3045-000'),
('FAR001', 'Centro Sul', 'Faro', 'Zona Industrial de Loulé', '8100-000'),
('AVR001', 'Armazém Aveiro', 'Aveiro', 'Zona Industrial de Aveiro Norte', '3800-000');