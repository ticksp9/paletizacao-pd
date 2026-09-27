-- Segurança: o papel de um utilizador novo NUNCA vem dos dados enviados no registo.
-- Antes, raw_user_meta_data->>'initial_role' era aceite, e qualquer pessoa com a chave
-- pública podia registar-se como 'admin'. Agora: o primeiro utilizador do projeto é admin;
-- todos os outros ficam 'pendente'. A Gestão de Utilizadores (manage-users, com service_role)
-- atribui o papel certo logo a seguir à criação.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _role app_role;
BEGIN
  INSERT INTO public.profiles (user_id, name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)), NEW.email)
  ON CONFLICT (user_id) DO NOTHING;

  -- Nunca substituir um papel já atribuído por outro caminho (ex.: manage-users).
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_roles) THEN
    _role := 'admin'::app_role;
  ELSE
    _role := 'pendente'::app_role;
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, _role)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
