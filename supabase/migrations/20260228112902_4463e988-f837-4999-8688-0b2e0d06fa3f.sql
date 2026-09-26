
CREATE OR REPLACE FUNCTION public.bootstrap_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only works if NO admin exists
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin') THEN
    RETURN false;
  END IF;

  -- Promote the calling user
  UPDATE public.user_roles
  SET role = 'admin'
  WHERE user_id = auth.uid();

  RETURN true;
END;
$$;
