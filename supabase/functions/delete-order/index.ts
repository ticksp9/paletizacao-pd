import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify user is admin
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: roleData } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .single();

    if (roleData?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Apenas administradores podem eliminar encomendas" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { order_id } = await req.json();
    if (!order_id) {
      return new Response(JSON.stringify({ error: "order_id é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch order info for audit
    const { data: order } = await adminClient
      .from("orders")
      .select("order_number, customer_name")
      .eq("id", order_id)
      .single();

    if (!order) {
      return new Response(JSON.stringify({ error: "Encomenda não encontrada" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Delete storage files (labels PDFs)
    const { data: labels } = await adminClient
      .from("labels")
      .select("pdf_storage_path")
      .eq("order_id", order_id);

    const { data: labelJobs } = await adminClient
      .from("label_jobs")
      .select("pdf_storage_path")
      .eq("order_id", order_id);

    const storagePaths = [
      ...(labels || []).map((l) => l.pdf_storage_path).filter(Boolean),
      ...(labelJobs || []).map((l) => l.pdf_storage_path).filter(Boolean),
    ] as string[];

    if (storagePaths.length > 0) {
      await adminClient.storage.from("labels").remove(storagePaths);
    }

    // Get palletization plan IDs
    const { data: plans } = await adminClient
      .from("palletization_plans")
      .select("id")
      .eq("order_id", order_id);
    const planIds = (plans || []).map((p) => p.id);

    // Delete in order: pallet_items -> palletization_plans -> labels -> label_jobs -> order_lines -> operation_history -> order
    if (planIds.length > 0) {
      await adminClient.from("pallet_items").delete().in("palletization_plan_id", planIds);
    }
    await adminClient.from("palletization_plans").delete().eq("order_id", order_id);
    await adminClient.from("labels").delete().eq("order_id", order_id);
    await adminClient.from("label_jobs").delete().eq("order_id", order_id);
    await adminClient.from("order_lines").delete().eq("order_id", order_id);
    await adminClient.from("operation_history").delete().eq("entity_id", order_id);
    await adminClient.from("orders").delete().eq("id", order_id);

    // Audit
    await adminClient.from("operation_history").insert({
      entity_type: "order",
      entity_id: order_id,
      action: "delete",
      performed_by: user.id,
      details: {
        order_number: order.order_number,
        customer_name: order.customer_name,
        deleted_at: new Date().toISOString(),
        storage_files_deleted: storagePaths.length,
        pallets_deleted: planIds.length,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Encomenda ${order.order_number} eliminada com sucesso`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
