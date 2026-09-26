import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const jsonResponse = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const denied = await requireRole(req, supabase, "admin", corsHeaders);
    if (denied) return denied;

    const authorization = req.headers.get("Authorization") || "";
    const bearerMatch = authorization.match(/^Bearer\s+(\S+)$/i);
    if (!bearerMatch) return jsonResponse({ success: false, error: "Não autenticado" }, 401);

    const { data: authenticatedUser, error: authError } =
      await supabase.auth.getUser(bearerMatch[1]);
    if (authError || !authenticatedUser.user) {
      return jsonResponse({ success: false, error: "Não autenticado" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      const parsedBody = await req.json();
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        return jsonResponse({ success: false, error: "Corpo JSON inválido" }, 400);
      }
      body = parsedBody as Record<string, unknown>;
    } catch {
      return jsonResponse({ success: false, error: "Corpo JSON inválido" }, 400);
    }
    const orderId = body.order_id;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (typeof orderId !== "string" || !UUID_PATTERN.test(orderId)) {
      return jsonResponse({ success: false, error: "order_id inválido" }, 400);
    }
    if (!reason) {
      return jsonResponse({ success: false, error: "reason é obrigatório" }, 400);
    }

    const { data, error } = await supabase.rpc("release_plan_issuance_admin", {
      p_order_id: orderId,
      p_actor_user_id: authenticatedUser.user.id,
      p_reason: reason,
    });
    if (error) {
      return jsonResponse({
        success: false,
        error: `Falha ao libertar reserva do plano: ${error.message}`,
      }, 500);
    }

    return jsonResponse({ success: true, data });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }, 500);
  }
});