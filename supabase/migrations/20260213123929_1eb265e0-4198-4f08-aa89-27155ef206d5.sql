
-- Add warehouse_code column (nullable for now to not break existing data)
ALTER TABLE public.pd_lg_locations ADD COLUMN IF NOT EXISTS warehouse_code text;

-- Add supermarket_name column
ALTER TABLE public.pd_lg_locations ADD COLUMN IF NOT EXISTS supermarket_name text;

-- Drop old unique index
DROP INDEX IF EXISTS idx_pd_lg_locations_company_location;

-- Create new unique constraint on (company_id, warehouse_code, location_id)
CREATE UNIQUE INDEX idx_pd_lg_locations_company_wh_location 
ON public.pd_lg_locations (company_id, warehouse_code, location_id);
