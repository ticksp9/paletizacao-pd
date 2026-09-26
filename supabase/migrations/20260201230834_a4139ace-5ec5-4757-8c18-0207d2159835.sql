-- Add layer configuration columns to articles
ALTER TABLE public.articles 
ADD COLUMN IF NOT EXISTS boxes_per_layer integer DEFAULT 4,
ADD COLUMN IF NOT EXISTS layers_per_pallet integer DEFAULT 5;

-- Add layer tracking to pallet_items
ALTER TABLE public.pallet_items
ADD COLUMN IF NOT EXISTS layer_number integer DEFAULT 1;

-- Update existing boxes_per_pallet based on new columns
UPDATE public.articles 
SET boxes_per_pallet = COALESCE(boxes_per_layer, 4) * COALESCE(layers_per_pallet, 5)
WHERE boxes_per_pallet IS NULL OR boxes_per_pallet = 1;