INSERT INTO storage.buckets (id, name, public)
VALUES ('exports', 'exports', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can upload exports"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'exports');

CREATE POLICY "Authenticated users can read exports"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'exports');

CREATE POLICY "Authenticated users can update exports"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'exports');