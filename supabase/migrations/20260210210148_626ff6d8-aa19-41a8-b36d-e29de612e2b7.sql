-- Add EAN column to articles for barcode/XML matching
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS ean text;
CREATE INDEX IF NOT EXISTS idx_articles_ean ON public.articles (ean) WHERE ean IS NOT NULL;