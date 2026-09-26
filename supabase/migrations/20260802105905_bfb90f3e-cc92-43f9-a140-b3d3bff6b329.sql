-- MEDIDA TEMPORÁRIA ONE-OFF: confirma contas antigas criadas pelo administrador
-- que ficaram bloqueadas por falta de confirmação de email. Não reutilizar como
-- mecanismo permanente; novas contas são confirmadas pela função manage-users.
UPDATE auth.users
SET email_confirmed_at = COALESCE(email_confirmed_at, now())
WHERE email_confirmed_at IS NULL;