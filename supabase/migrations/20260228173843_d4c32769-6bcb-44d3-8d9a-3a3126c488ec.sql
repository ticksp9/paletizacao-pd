
-- Add lg_code to order_lines to track which LG each line belongs to
ALTER TABLE public.order_lines ADD COLUMN IF NOT EXISTS lg_code text;

-- Add lg_code to palletization_plans to associate pallets with LG groups
ALTER TABLE public.palletization_plans ADD COLUMN IF NOT EXISTS lg_code text;

-- Add lg_code to label_jobs for per-LG label generation
ALTER TABLE public.label_jobs ADD COLUMN IF NOT EXISTS lg_code text;

-- Add lg_code to labels
ALTER TABLE public.labels ADD COLUMN IF NOT EXISTS lg_code text;
