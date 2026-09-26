-- Add fields needed for PD padrão label template
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS soc_code TEXT,
  ADD COLUMN IF NOT EXISTS store_code TEXT,
  ADD COLUMN IF NOT EXISTS lg_code TEXT;

-- Add customer_type to delivery_sites for configurable label text (e.g. "HIPER", "BRAGA")
ALTER TABLE public.delivery_sites
  ADD COLUMN IF NOT EXISTS customer_type TEXT;