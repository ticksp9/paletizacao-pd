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
      return new Response(JSON.stringify({ error: "Apenas administradores" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { reset_type } = await req.json(); // "operational" or "complete"

    const report: Record<string, number> = {};

    // Count before deleting
    const countTable = async (table: string) => {
      const { count } = await adminClient.from(table).select("*", { count: "exact", head: true });
      return count || 0;
    };

    // 1. Delete storage files
    const { data: allLabels } = await adminClient.from("labels").select("pdf_storage_path");
    const { data: allJobs } = await adminClient.from("label_jobs").select("pdf_storage_path");
    const storagePaths = [
      ...(allLabels || []).map((l) => l.pdf_storage_path).filter(Boolean),
      ...(allJobs || []).map((l) => l.pdf_storage_path).filter(Boolean),
    ] as string[];

    if (storagePaths.length > 0) {
      await adminClient.storage.from("labels").remove(storagePaths);
    }
    report.storage_files = storagePaths.length;

    // 2. Operational data - delete in order
    report.pallet_items = await countTable("pallet_items");
    await adminClient.from("pallet_items").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    report.palletization_plans = await countTable("palletization_plans");
    await adminClient.from("palletization_plans").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    report.labels = await countTable("labels");
    await adminClient.from("labels").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    report.label_jobs = await countTable("label_jobs");
    await adminClient.from("label_jobs").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    report.order_lines = await countTable("order_lines");
    await adminClient.from("order_lines").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    report.orders = await countTable("orders");
    await adminClient.from("orders").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    report.edi_files = await countTable("edi_files");
    await adminClient.from("edi_files").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    report.operation_history = await countTable("operation_history");
    await adminClient.from("operation_history").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    // 3. If complete, also delete master data
    if (reset_type === "complete") {
      report.articles = await countTable("articles");
      await adminClient.from("articles").delete().neq("id", "00000000-0000-0000-0000-000000000000");

      report.pd_lg_locations = await countTable("pd_lg_locations");
      await adminClient.from("pd_lg_locations").delete().neq("id", "00000000-0000-0000-0000-000000000000");

      report.delivery_sites = await countTable("delivery_sites");
      await adminClient.from("delivery_sites").delete().neq("id", "00000000-0000-0000-0000-000000000000");

      report.packaging = await countTable("packaging");
      await adminClient.from("packaging").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }

    // Clean EDI storage
    const { data: ediFiles } = await adminClient.storage.from("edi-files").list();
    if (ediFiles && ediFiles.length > 0) {
      await adminClient.storage.from("edi-files").remove(ediFiles.map((f) => f.name));
      report.edi_storage_files = ediFiles.length;
    }

    // Audit
    await adminClient.from("operation_history").insert({
      entity_type: "system",
      entity_id: "00000000-0000-0000-0000-000000000000",
      action: `reset_${reset_type}`,
      performed_by: user.id,
      details: {
        reset_type,
        report,
        performed_at: new Date().toISOString(),
      },
    });

    return new Response(
      JSON.stringify({ success: true, report, reset_type }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
