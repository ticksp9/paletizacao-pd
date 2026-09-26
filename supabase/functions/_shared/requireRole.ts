type CorsHeaders = Record<string, string>;

function jsonError(
  status: number,
  error: string,
  corsHeaders: CorsHeaders,
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Authorizes a request with a Supabase Auth access token and one current
 * user_roles entry matching an allowed role. Returns null when authorized,
 * otherwise a JSON+CORS error response for the caller to return immediately.
 */
export async function requireRole(
  req: Request,
  adminClient: any,
  requiredRoles: string | readonly string[],
  corsHeaders: CorsHeaders,
): Promise<Response | null> {
  const authorization = req.headers.get("Authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!bearerMatch) {
    return jsonError(401, "Não autenticado", corsHeaders);
  }

  let user: { id: string } | null;
  try {
    const { data, error } = await adminClient.auth.getUser(bearerMatch[1]);
    if (error) {
      if (error.status && error.status >= 500) {
        return jsonError(503, "Não foi possível verificar a autenticação", corsHeaders);
      }
      return jsonError(401, "Não autenticado", corsHeaders);
    }
    user = data.user;
  } catch {
    return jsonError(503, "Não foi possível verificar a autenticação", corsHeaders);
  }

  if (!user) {
    return jsonError(401, "Não autenticado", corsHeaders);
  }

  let role: string | null;
  try {
    const { data, error } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      return jsonError(503, "Não foi possível verificar as permissões", corsHeaders);
    }
    role = data?.role ?? null;
  } catch {
    return jsonError(503, "Não foi possível verificar as permissões", corsHeaders);
  }

  const allowed = typeof requiredRoles === "string" ? [requiredRoles] : requiredRoles;
  if (!role || !allowed.includes(role)) {
    return jsonError(403, "Sem permissão para esta operação", corsHeaders);
  }

  return null;
}