import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireRole } from "../_shared/requireRole.ts";
import { resolveStoreName, type StoreResolution } from "../_shared/resolveStoreName.ts";
import { planLabelVolumes, type DedicatedMode } from "../_shared/labelVolumePlan.ts";
import {
  collectPalletPairs,
  compareLabelPrintOrder,
  createLabelsPdf,
  resolveDeliveryLabel,
  resolveWarehouse,
  type LabelEntry,
} from "../generate-labels-pdf/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const missingSoc = "SOC POR EMITIR";
const jsonError = (status: number, error: string) =>
  new Response(JSON.stringify({ success: false, error }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// This endpoint has no issuance RPC, storage upload or database mutation.
// A distinct slug makes a frontend-first rollout fail closed (404) instead
// of accidentally invoking an older issuing function.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError(405, "Método não permitido");

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authResponse = await requireRole(
      req, supabase, ["admin", "operador", "etiquetas"], corsHeaders,
    );
    if (authResponse) return authResponse;

    const body = await req.json();
    const { order_id, dedicated_mode = "pallet" } = body;
    if (typeof order_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order_id)) {
      return jsonError(400, "order_id inválido");
    }
    if (dedicated_mode !== "pallet" && dedicated_mode !== "boxes") {
      return jsonError(400, "Modo de etiquetas dedicadas inválido");
    }
    const mode: DedicatedMode = dedicated_mode;

    const { data: order, error: orderError } = await supabase
      .from("orders").select("*").eq("id", order_id).single();
    if (orderError || !order) return jsonError(404, "Encomenda não encontrada");

    const { data: pallets, count: palletCount, error: palletError } = await supabase
      .from("palletization_plans")
      .select("id, pallet_number, soc_code", { count: "exact" })
      .eq("order_id", order_id).order("pallet_number");
    if (palletError || palletCount == null || pallets?.length !== palletCount) {
      throw new Error("Não foi possível ler todas as paletes da encomenda");
    }
    if (!pallets.length) return jsonError(400, "A encomenda ainda não tem paletes");
    const palletIds = pallets.map((p) => p.id);

    const { data: containers, count: containerCount, error: containerError } = await supabase
      .from("pallet_store_containers")
      .select("palletization_plan_id, store_code, soc_code", { count: "exact" })
      .in("palletization_plan_id", palletIds);
    if (containerError || containerCount == null || containers?.length !== containerCount) {
      throw new Error("Não foi possível ler todos os contentores da encomenda");
    }
    const containerSocByPlan = new Map<string, Map<string, string>>();
    for (const container of containers) {
      if (!palletIds.includes(container.palletization_plan_id) ||
        !container.store_code?.trim() || !container.soc_code?.trim()) {
        throw new Error("Contentor sem palete, loja ou SOC válido");
      }
      if (!containerSocByPlan.has(container.palletization_plan_id)) {
        containerSocByPlan.set(container.palletization_plan_id, new Map());
      }
      const byStore = containerSocByPlan.get(container.palletization_plan_id)!;
      if (byStore.has(container.store_code)) throw new Error("SOC duplicado para a loja");
      byStore.set(container.store_code, container.soc_code);
    }

    const { warehouseCode: parsedWarehouse, deliveryNameRaw } = resolveWarehouse(order);
    let warehouseCode = parsedWarehouse;
    if (order.delivery_site_id) {
      const { data: site, error: siteError } = await supabase.from("delivery_sites")
        .select("internal_code").eq("id", order.delivery_site_id).maybeSingle();
      if (siteError) throw new Error(`Falha ao ler local de entrega: ${siteError.message}`);
      if (site?.internal_code) warehouseCode ||= site.internal_code;
    }
    if (!warehouseCode) return jsonError(400, "Armazém de entrega em falta");
    const deliveryLabel = await resolveDeliveryLabel(
      supabase, warehouseCode, deliveryNameRaw, order.delivery_site_id,
    );
    if (!deliveryLabel) return jsonError(400, "Nome de entrega em falta");

    const labels: LabelEntry[] = [];
    const cache = new Map<string, StoreResolution>();
    for (const pallet of pallets) {
      const persistedSoc = containerSocByPlan.get(pallet.id);
      const groups = await collectPalletPairs(supabase, pallet.id, !!persistedSoc);
      const mixed = new Set(groups.map((group) => group.store_code)).size > 1;
      // Missing SOCs remain visibly unissued; never request a sequence value.
      const socByStore = new Map(persistedSoc);
      for (const group of groups) {
        if (!socByStore.has(group.store_code)) {
          socByStore.set(
            group.store_code,
            persistedSoc || mixed ? missingSoc : pallet.soc_code || missingSoc,
          );
        }
      }
      const volumes = planLabelVolumes(groups, socByStore, "", mode);
      for (const volume of volumes) {
        const name = await resolveStoreName(
          supabase, warehouseCode, volume.store_code, volume.lg_code, cache,
          { order_id, pallet_number: pallet.pallet_number },
        );
        labels.push({
          ...volume,
          pallet_number: pallet.pallet_number,
          pallet_total: palletCount,
          order_ref: String(order.order_number || ""),
          delivery_label: deliveryLabel,
          store_name: name.store_name,
          store_city: name.store_city,
          warning: name.warning,
        });
      }
    }
    labels.sort(compareLabelPrintOrder);
    const pdf = await createLabelsPdf(labels, true);
    return new Response(pdf, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="pre-visualizacao-${order.order_number}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Falha ao pré-visualizar etiquetas:", error);
    return jsonError(500, error instanceof Error ? error.message : "Falha ao gerar pré-visualização");
  }
});