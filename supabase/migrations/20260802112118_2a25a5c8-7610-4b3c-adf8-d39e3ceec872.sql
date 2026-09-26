CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
  _initial text;
BEGIN
  _initial := NEW.raw_user_meta_data->>'initial_role';

  INSERT INTO public.profiles (user_id, name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)), NEW.email)
  ON CONFLICT (user_id) DO NOTHING;

  -- Never override a role already set by another path (e.g. admin create-user)
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  IF _initial IS NOT NULL AND _initial IN ('admin','operador','etiquetas','pendente') THEN
    _role := _initial::app_role;
  ELSIF NOT EXISTS (SELECT 1 FROM public.user_roles) THEN
    _role := 'admin'::app_role;
  ELSE
    _role := 'pendente'::app_role;
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, _role)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$function$;