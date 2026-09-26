-- Add soc_code column to palletization_plans for per-pallet SOC tracking
ALTER TABLE public.palletization_plans ADD COLUMN soc_code TEXT;