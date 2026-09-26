import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const requiredSecrets = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
    const secrets: Partial<Record<(typeof requiredSecrets)[number], string>> = {};
    for (const name of requiredSecrets) {
      const value = Deno.env.get(name);
      if (!value) return json({ error: `Configuração em falta: ${name}` }, 500);
      secrets[name] = value;
    }

    const supabaseUrl = secrets.SUPABASE_URL;
    const anonKey = secrets.SUPABASE_ANON_KEY;
    const serviceRoleKey = secrets.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json({ error: 'Configuração em falta.' }, 500);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.match(/^Bearer\s+\S+/i)) return json({ error: 'Sessão inválida.' }, 401);

    let body: { current_password?: unknown; new_password?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Pedido inválido.' }, 400);
    }

    const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
    if (!currentPassword) return json({ error: 'Indique a palavra-passe atual.' }, 400);
    if (newPassword.length < 8 || newPassword.length > 72) {
      return json({ error: 'A palavra-passe tem de ter entre 8 e 72 caracteres.' }, 400);
    }
    if (newPassword === currentPassword) return json({ error: 'A nova palavra-passe tem de ser diferente da atual.' }, 400);

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !user) return json({ error: 'Sessão inválida.' }, 401);
    if (!user.email) return json({ error: 'O utilizador não tem email associado.' }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: currentRole, error: roleErr } = await adminClient
      .from('user_roles').select('role').eq('user_id', user.id).maybeSingle();
    if (roleErr) return json({ error: 'Não foi possível verificar as permissões.' }, 503);
    // A conta pendente também pode alterar a sua própria palavra-passe,
    // mas ninguém sem papel registado pode usar permissões de serviço.
    if (!currentRole || !['admin', 'operador', 'etiquetas', 'pendente'].includes(currentRole.role)) {
      return json({ error: 'Sem permissão para esta operação.' }, 403);
    }

    const { error: reauthErr } = await anonClient.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (reauthErr) return json({ error: 'Palavra-passe atual incorreta.' }, 400);

    const { error: updErr } = await adminClient.auth.admin.updateUserById(user.id, {
      password: newPassword,
      email_confirm: true,
    });
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ success: true });
  } catch (e) {
    console.error('self-set-password unexpected error:', e);
    return json({ error: e instanceof Error ? e.message : 'Erro interno.' }, 500);
  }
});
