ALTER TABLE public.palletization_plans
  ADD COLUMN IF NOT EXISTS pallet_size text,
  ADD COLUMN IF NOT EXISTS base_length_mm integer,
  ADD COLUMN IF NOT EXISTS base_width_mm integer,
  ADD COLUMN IF NOT EXISTS height_mm integer,
  ADD COLUMN IF NOT EXISTS total_layers integer,
  ADD COLUMN IF NOT EXISTS total_pieces integer,
  ADD COLUMN IF NOT EXISTS is_mixed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS base_usage_pct numeric,
  ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.pallet_items
  ADD COLUMN IF NOT EXISTS pos_x_mm integer,
  ADD COLUMN IF NOT EXISTS pos_y_mm integer,
  ADD COLUMN IF NOT EXISTS pos_z_mm integer,
  ADD COLUMN IF NOT EXISTS box_length_mm integer,
  ADD COLUMN IF NOT EXISTS box_width_mm integer,
  ADD COLUMN IF NOT EXISTS box_height_mm integer,
  ADD COLUMN IF NOT EXISTS rotated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS article_code text,
  ADD COLUMN IF NOT EXISTS store_code text,
  ADD COLUMN IF NOT EXISTS lg_code text;

CREATE INDEX IF NOT EXISTS pallet_items_plan_idx ON public.pallet_items (palletization_plan_id);