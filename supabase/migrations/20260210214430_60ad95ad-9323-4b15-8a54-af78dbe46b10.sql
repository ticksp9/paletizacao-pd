-- Create masterdata storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('masterdata', 'masterdata', false)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to masterdata bucket
CREATE POLICY "Authenticated users can upload to masterdata"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'masterdata');

-- Allow authenticated users to read from masterdata bucket
CREATE POLICY "Authenticated users can read masterdata"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'masterdata');