DROP INDEX IF EXISTS public.pd_internal_article_codes_ean_active_idx;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pd_internal_article_codes_ean_key'
      AND conrelid = 'public.pd_internal_article_codes'::regclass
  ) THEN
    ALTER TABLE public.pd_internal_article_codes
    ADD CONSTRAINT pd_internal_article_codes_ean_key UNIQUE (ean);
  END IF;
END $$;