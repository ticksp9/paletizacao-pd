import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  formatStoreLabelCity,
  formatStoreLabelName,
  resolveStoreName,
  type StoreResolution,
} from "../_shared/resolveStoreName.ts";
import { requireRole } from "../_shared/requireRole.ts";
import { planLabelVolumes, type BoxGroup, type DedicatedMode } from "../_shared/labelVolumePlan.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Dimensions (100×80 mm at 8 dpmm) ───────────────────────
const DPM = 8;
const W = 100 * DPM;
const H = 80 * DPM;
const M = 5 * DPM; // margin

// ── Label data contract ─────────────────────────────────────
export interface LabelEntry {
  store_code: string;   // from order line (never overwritten)
  lg_code: string;      // from order line (never overwritten)
  pallet_number: number;
  pallet_total: number;
  soc_code: string;
  order_ref: string;
  delivery_label: string;
  // enrichment from masterdata (query-only)
  store_name: string;   // line 1 (big)
  store_city: string;   // line 2
  // assigned later
  volume_no: number;
  volume_total: number;
  box_count: number | null;
  warning?: string | null;
}

function compareLabelPrintOrder(a: LabelEntry, b: LabelEntry): number {
  const aLgMatch = a.lg_code.match(/\d+/);
  const bLgMatch = b.lg_code.match(/\d+/);
  const aLg = aLgMatch ? parseInt(aLgMatch[0], 10) : -1;
  const bLg = bLgMatch ? parseInt(bLgMatch[0], 10) : -1;
  return a.pallet_number - b.pallet_number ||
    bLg - aLg ||
    a.store_code.localeCompare(b.store_code) ||
    a.lg_code.localeCompare(b.lg_code) ||
    a.volume_no - b.volume_no;
}

function isDeterministicFinalizeRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code || "");
  return new Set(["P0001", "42501", "22004", "22023", "23502", "23503", "23505", "23514", "55000"])
    .has(code);
}

// ── Resolve warehouse from order ────────────────────────────
function resolveWarehouse(order: Record<string, unknown>): { warehouseCode: string; deliveryNameRaw: string } {
  let warehouseCode = "";
  let deliveryNameRaw = "";

  if (order.store_code && String(order.store_code).trim()) {
    warehouseCode = String(order.store_code).trim();
  }

  const notes = String(order.notes || "");
  if (!warehouseCode && notes) {
    const m = notes.match(/Local:\s*(\d+)/i) || notes.match(/Entrega:.*?\((\d+)\)/i);
    if (m) warehouseCode = m[1];
  }

  if (notes) {
    const m1 = notes.match(/Local:\s*\d+\s*-\s*(.+?)(?:\s*N\/P\s*)?$/im);
    if (m1) deliveryNameRaw = m1[1].trim();
    if (!deliveryNameRaw) {
      const m2 = notes.match(/Entrega:\s*(.+?)\s*\(\d+\)/i);
      if (m2) deliveryNameRaw = m2[1].trim();
    }
  }

  return { warehouseCode, deliveryNameRaw };
}

function cleanDeliveryName(raw: string): string {
  return raw.replace(/^PD\s*-\s*/i, "").replace(/\s*N\/P\s*$/i, "").trim();
}

async function resolveDeliveryLabel(
  supabase: ReturnType<typeof createClient>,
  warehouseCode: string,
  deliveryNameRaw: string,
  deliverySiteId: string | null,
): Promise<string> {
  if (deliverySiteId) {
    const { data: site } = await supabase
      .from("delivery_sites")
      .select("internal_code, label_name")
      .eq("id", deliverySiteId)
      .maybeSingle();
    if (site) {
      const code = site.internal_code || warehouseCode;
      return `${site.label_name}(${code})`;
    }
  }
  if (warehouseCode) {
    const { data: site } = await supabase
      .from("delivery_sites")
      .select("label_name")
      .eq("internal_code", warehouseCode)
      .eq("active", true)
      .maybeSingle();
    if (site?.label_name) return `${site.label_name}(${warehouseCode})`;
  }
  if (warehouseCode) {
    const { data: loc } = await supabase
      .from("pd_lg_locations")
      .select("supermarket_name")
      .eq("warehouse_code", warehouseCode)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (loc?.supermarket_name) {
      const cleaned = cleanDeliveryName(String(loc.supermarket_name));
      if (cleaned) return `${cleaned}(${warehouseCode})`;
    }
  }
  if (deliveryNameRaw) {
    const cleaned = cleanDeliveryName(deliveryNameRaw);
    if (cleaned) return `${cleaned}(${warehouseCode})`;
  }
  return "";
}

// ── Collect distinct (store_code, lg_code) pairs per pallet ─
async function collectPalletPairs(
  supabase: ReturnType<typeof createClient>,
  palletId: string,
  usePersistedPairs: boolean,
): Promise<BoxGroup[]> {
  const itemSelection = usePersistedPairs
    ? "id, order_line_id, store_code, lg_code, soc_code, layer_number, placement_sequence"
    : "order_line_id";
  const { data: items, count: itemCount, error: itemsError } = await supabase
    .from("pallet_items")
    .select(itemSelection, { count: "exact" })
    .eq("palletization_plan_id", palletId);
  if (itemsError) throw new Error(`Falha ao buscar itens do palete ${palletId}: ${itemsError.message}`);
  if (itemCount == null) throw new Error(`Falha ao contar itens do palete ${palletId}`);
  if ((items || []).length !== itemCount) {
    throw new Error(`Itens do palete ${palletId} incompletos: recebidos ${(items || []).length} de ${itemCount}`);
  }
  if (itemCount > 1000) {
    throw new Error(`Palete ${palletId} tem ${itemCount} itens; limite suportado para etiquetas: 1000`);
  }

  const lineIds = (items || [])
    .map((i: { order_line_id: string | null }) => i.order_line_id)
    .filter(Boolean) as string[];

  const { data: lines, error: linesError } = lineIds.length
    ? await supabase.from("order_lines").select("id, store_code, lg_code").in("id", lineIds)
    : { data: [], error: null };
  if (linesError) throw new Error(`Falha ao buscar linhas do palete ${palletId}: ${linesError.message}`);

  if (usePersistedPairs) {
    const lineStoreById = new Map<string, string | null>();
    for (const line of lines || []) {
      const id = String((line as { id: string }).id);
      const storeCode = String((line as { store_code: string | null }).store_code || "").trim();
      lineStoreById.set(id, storeCode || null);
    }
    for (const lineId of new Set(lineIds)) {
      if (!lineStoreById.has(lineId)) {
        throw new Error(`Linha ${lineId} referenciada pelo palete ${palletId} não foi encontrada`);
      }
    }

    // Mesma ordem em que os SOC por caixa foram gerados: camada, sequência de colocação.
    const orderedItems = [...(items || [])].sort((a, b) => {
      const ra = a as { layer_number: number | null; placement_sequence: number | null; id: string };
      const rb = b as { layer_number: number | null; placement_sequence: number | null; id: string };
      return (ra.layer_number ?? 0) - (rb.layer_number ?? 0) ||
        (ra.placement_sequence ?? Number.MAX_SAFE_INTEGER) - (rb.placement_sequence ?? Number.MAX_SAFE_INTEGER) ||
        String(ra.id).localeCompare(String(rb.id));
    });
    const groups = new Map<string, BoxGroup>();
    for (const item of orderedItems) {
      const row = item as {
        order_line_id: string | null;
        store_code: string | null;
        lg_code: string | null;
        soc_code: string | null;
      };
      const storeCode = String(row.store_code || "").trim();
      const lgCode = String(row.lg_code || "").trim();
      if (!storeCode || !lgCode) {
        throw new Error(`Item do palete ${palletId} sem store_code ou lg_code persistido`);
      }

      const orderLineStoreCode = row.order_line_id
        ? lineStoreById.get(row.order_line_id)
        : undefined;
      if (orderLineStoreCode && orderLineStoreCode !== storeCode) {
        throw new Error(
          `Loja divergente no palete ${palletId}: pallet_items=${storeCode}, order_lines=${orderLineStoreCode}`,
        );
      }

      const key = `${storeCode}|${lgCode}`;
      const boxSoc = String(row.soc_code || "").trim();
      const group = groups.get(key);
      if (group) {
        group.box_count++;
        if (boxSoc) (group.box_socs ??= []).push(boxSoc);
      } else {
        groups.set(key, {
          store_code: storeCode,
          lg_code: lgCode,
          box_count: 1,
          ...(boxSoc ? { box_socs: [boxSoc] } : {}),
        });
      }
    }
    return [...groups.values()];
  }

  const lineById = new Map((lines || []).map((line) => [line.id, line]));
  const groups = new Map<string, BoxGroup>();
  for (const item of items || []) {
    const line = lineById.get(item.order_line_id);
    const sc = String(line?.store_code || "").trim();
    const lg = String(line?.lg_code || "").trim();
    if (!sc || !lg) throw new Error(`Item do palete ${palletId} sem loja ou LG na linha de encomenda`);
    const key = `${sc}|${lg}`;
    const group = groups.get(key);
    if (group) group.box_count++;
    else groups.set(key, { store_code: sc, lg_code: lg, box_count: 1 });
  }

  return [...groups.values()];
}

// ── Build ZPL for one label ─────────────────────────────────
export function buildLabelZpl(label: LabelEntry): string {
  const sn = (s: string) => s;
  const usable = W - 2 * M;
  const displayName = formatStoreLabelName(label.store_name, label.store_code);
  const displayCity = formatStoreLabelCity(label.store_city, displayName);

  let zpl = "";
  zpl += "^XA\n";
  zpl += "^CI28\n";
  zpl += `^PW${W}\n`;
  zpl += `^LL${H}\n`;
  zpl += "^LH0,0\n";

  // HEADER
  zpl += `^CF0,28\n`;
  zpl += `^FO${M},25^FB${usable},1,0,C^FD${sn("Soceramica-Fabrica de Louça Regional, Lda")}^FS\n`;
  zpl += `^FO${M},60^GB${usable},0,2^FS\n`;

  // CLIENT BLOCK (store name + city from masterdata enrichment)
  zpl += `^CF0,26\n`;
  zpl += `^FO${M},75^FD${sn(displayName)}^FS\n`;
  zpl += `^CF0,24\n`;
  if (displayCity) zpl += `^FO${M},118^FD${sn(displayCity)}^FS\n`;

  // LOJA left, LG right
  zpl += `^CF0,26\n`;
  const lgDisplay = label.lg_code.replace(/^LG/i, "");
  zpl += `^FO${M},165^FDLOJA: ${sn(label.store_code)}^FS\n`;
  zpl += `^FO${M},165^FB${usable},1,0,R^FDLG: ${sn(lgDisplay)}^FS\n`;

  zpl += `^FO${M},195^GB${usable},0,2^FS\n`;

  // ORDER BLOCK
  zpl += `^CF0,26\n`;
  zpl += `^FO${M},195^FDOC: ${sn(label.order_ref)}^FS\n`;
  zpl += `^FO${M},195^FB${usable},1,0,R^FDEntrega: ${sn(label.delivery_label)}^FS\n`;

  zpl += `^FO${M},228^GB${usable},0,2^FS\n`;

  // VOLUME (above barcode with clear gap)
  zpl += `^CF0,30\n`;
  zpl += `^FO${M},245^FDVolume ${label.volume_no} de ${label.volume_total}^FS\n`;
  if (typeof label.box_count === "number") {
    zpl += `^FO${M},245^FB${usable},1,0,R^FD${label.box_count} caixas^FS\n`;
  }
  zpl += `^FO${M},252^A0N,14,14^FB${usable},1,0,R^FDPalete ${label.pallet_number}/${label.pallet_total}^FS\n`;

  // Barcode (starts well below Volume text)
  const barcodeX = Math.round((W - 300) / 2);
  zpl += `^FO${barcodeX},290\n`;
  zpl += `^BY2\n`;
  zpl += `^BCN,90,Y,N,N\n`;
  zpl += `^FD${label.soc_code}^FS\n`;

  zpl += "^XZ\n";
  return zpl;
}

// ── Main handler ────────────────────────────────────────────
interface HeldReservation {
  orderId: string | null;
  token: string | null;
}

async function handleRequest(req: Request, held: HeldReservation): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    const authResponse = await requireRole(req, supabase, ["admin", "operador", "etiquetas"], corsHeaders);
    if (authResponse) return authResponse;
    const bearerMatch = (req.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
    if (!bearerMatch) {
      return new Response(
        JSON.stringify({ success: false, error: "Não autenticado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const { data: authenticatedUser, error: authenticatedUserError } =
      await supabase.auth.getUser(bearerMatch[1]);
    if (authenticatedUserError || !authenticatedUser.user) {
      return new Response(
        JSON.stringify({ success: false, error: "Não autenticado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const actorUserId = authenticatedUser.user.id;

    const { order_id, pallet_ids, dedicated_mode = "pallet" } = await req.json();

    if (!order_id) {
      return new Response(
        JSON.stringify({ success: false, error: "order_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (typeof order_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order_id)) {
      return new Response(
        JSON.stringify({ success: false, error: "order_id inválido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (dedicated_mode !== "pallet" && dedicated_mode !== "boxes") {
      return new Response(
        JSON.stringify({ success: false, error: "Modo de etiquetas dedicadas inválido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const dedicatedMode: DedicatedMode = dedicated_mode;

    // Freeze the plan before reading it or publishing any labels. Completion
    // releases the reservation only after label output and persistence succeed.
    // Regra de alteração: entregue = fechada; ficheiro já gerado = só administrador.
    const { data: changeBlock, error: changeBlockError } = await supabase
      .rpc("order_change_block_reason", { p_order_id: order_id, p_actor_user_id: actorUserId });
    if (changeBlockError) {
      throw new Error(`Falha a verificar se a encomenda pode ser alterada: ${changeBlockError.message}`);
    }
    if (changeBlock) {
      return new Response(
        JSON.stringify({ success: false, error: changeBlock, code: "ORDER_CHANGE_BLOCKED" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: reservationToken, error: reservationError } = await supabase
      .rpc("reserve_plan_issuance", { p_order_id: order_id });
    if (reservationError || !reservationToken) {
      throw new Error(`Falha ao reservar o plano para emissão: ${reservationError?.message || "token não recebido"}`);
    }
    held.orderId = order_id;
    held.token = String(reservationToken);

    const { data: order, error: orderError } = await supabase
      .from("orders").select("*").eq("id", order_id).single();
    if (orderError || !order) throw new Error(`Encomenda não encontrada: ${orderError?.message}`);

    let query = supabase
      .from("palletization_plans")
      .select("id, pallet_number, soc_code, lg_code, notes, single_label")
      .eq("order_id", order_id)
      .order("pallet_number");
    if (pallet_ids?.length > 0) query = query.in("id", pallet_ids);

    const { data: pallets, error: palletsError } = await query;
    if (palletsError) throw new Error(`Falha ao buscar paletes: ${palletsError.message}`);
    if (!pallets || pallets.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Esta encomenda ainda não tem paletes. Abra a encomenda e faça primeiro as paletes.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { count: palletTotal, error: palletCountError } = await supabase
      .from("palletization_plans")
      .select("id", { count: "exact", head: true })
      .eq("order_id", order_id);
    if (palletCountError || palletTotal == null) {
      throw new Error(`Falha ao contar paletes da encomenda: ${palletCountError?.message || "contagem indisponível"}`);
    }

    const palletIds = pallets.map((pallet) => pallet.id);
    const { data: rawContainers, count: containerCount, error: containersError } = await supabase
      .from("pallet_store_containers")
      .select("palletization_plan_id, store_code, soc_code", { count: "exact" })
      .in("palletization_plan_id", palletIds);
    if (containersError) {
      throw new Error(`Falha ao buscar SOCs por loja: ${containersError.message}`);
    }
    if (containerCount == null || (rawContainers || []).length !== containerCount) {
      throw new Error(
        `Consulta de SOCs por loja incompleta: recebidos ${(rawContainers || []).length} de ${containerCount ?? "?"}`,
      );
    }

    const plansWithContainers = new Set<string>();
    const containerSocByPlan = new Map<string, Map<string, string>>();
    for (const container of (rawContainers || []) as Array<{
      palletization_plan_id: string;
      store_code: string;
      soc_code: string;
    }>) {
      const storeCode = String(container.store_code || "").trim();
      const socCode = String(container.soc_code || "").trim();
      if (!storeCode || !socCode) {
        throw new Error(
          `Contentor do palete ${container.palletization_plan_id} sem loja ou SOC`,
        );
      }
      plansWithContainers.add(container.palletization_plan_id);
      if (!containerSocByPlan.has(container.palletization_plan_id)) {
        containerSocByPlan.set(container.palletization_plan_id, new Map());
      }
      containerSocByPlan.get(container.palletization_plan_id)!.set(storeCode, socCode);
    }

    // Resolve warehouse
    const { warehouseCode: parsedWarehouse, deliveryNameRaw } = resolveWarehouse(order);
    let effectiveWarehouse = parsedWarehouse;
    if (order.delivery_site_id) {
      const { data: site } = await supabase
        .from("delivery_sites").select("internal_code")
        .eq("id", order.delivery_site_id).maybeSingle();
      if (site?.internal_code) effectiveWarehouse = effectiveWarehouse || site.internal_code;
    }
    if (!effectiveWarehouse) {
      return new Response(
        JSON.stringify({ success: false, error: "warehouse_code não encontrado." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const deliveryLabel = await resolveDeliveryLabel(supabase, effectiveWarehouse, deliveryNameRaw, order.delivery_site_id);
    if (!deliveryLabel) {
      return new Response(
        JSON.stringify({ success: false, error: `Não foi possível resolver entrega para armazém ${effectiveWarehouse}.` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate SOC codes for pallets missing them
    for (const pallet of pallets) {
      if (plansWithContainers.has(pallet.id)) continue;
      if (!pallet.soc_code || pallet.soc_code.trim() === "") {
        const { data: generated, error: genError } = await supabase.rpc("generate_soc_code");
        if (genError || !generated) throw new Error(`Falha ao gerar SOC: ${genError?.message}`);
        pallet.soc_code = generated as string;
        const { error: socUpdateError } = await supabase
          .from("palletization_plans")
          .update({ soc_code: pallet.soc_code })
          .eq("id", pallet.id);
        if (socUpdateError) {
          throw new Error(`Falha ao gravar SOC da palete ${pallet.pallet_number}: ${socUpdateError.message}`);
        }
      }
    }

    // Count persisted boxes first; mixed pallets always receive one label per box.
    const nameCache = new Map<string, StoreResolution>();
    const allLabels: LabelEntry[] = [];

    for (const pallet of pallets) {
      const hasContainers = plansWithContainers.has(pallet.id);
      const groups = await collectPalletPairs(
        supabase,
        pallet.id,
        hasContainers,
      );

      const volumes = planLabelVolumes(
        groups,
        containerSocByPlan.get(pallet.id) || new Map(),
        pallet.soc_code || "",
        // Palete completa (definida pelo administrador): 1 SOC e 1 etiqueta.
        pallet.single_label ? "pallet" : dedicatedMode,
      );

      for (const volume of volumes) {
        const enrichment = await resolveStoreName(
          supabase, effectiveWarehouse, volume.store_code, volume.lg_code, nameCache,
          { order_id, pallet_number: pallet.pallet_number },
        );

        allLabels.push({
          ...volume,
          pallet_number: pallet.pallet_number,
          pallet_total: palletTotal,
          order_ref: String(order.order_number || ""),
          delivery_label: deliveryLabel,
          store_name: enrichment.store_name,
          store_city: enrichment.store_city,
          warning: enrichment.warning,
        });
      }
    }

    // Pallet, LG descending, store, then volume 1..n.
    allLabels.sort(compareLabelPrintOrder);

    // Validate
    const allErrors: string[] = [];
    for (let i = 0; i < allLabels.length; i++) {
      const l = allLabels[i];
      if (!l.store_code) allErrors.push(`Label ${i + 1}: store_code em falta`);
      if (!l.lg_code) allErrors.push(`Label ${i + 1}: lg_code em falta`);
      if (!l.soc_code) allErrors.push(`Label ${i + 1}: soc_code em falta`);
      if (!l.delivery_label) allErrors.push(`Label ${i + 1}: delivery_label em falta`);
    }
    if (allErrors.length > 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Dados incompletos.", validation_errors: allErrors }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate ZPL
    let fullZpl = "";
    for (const label of allLabels) {
      fullZpl += buildLabelZpl(label);
    }

    const warnings = Array.from(
      new Set(allLabels.map((l) => l.warning).filter(Boolean) as string[]),
    );

    const filename = `labels_${order.order_number}_${Date.now()}.zpl`;
    const storagePath = `${order_id}/${crypto.randomUUID()}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("labels")
      .upload(storagePath, new TextEncoder().encode(fullZpl), { contentType: "application/octet-stream", upsert: false });
    if (uploadError) throw new Error(`Upload falhou: ${uploadError.message}`);

    const labelData = {
      format: "zpl",
      dedicated_mode: dedicatedMode,
      warehouse_code: effectiveWarehouse,
      delivery_label: deliveryLabel,
      labels: allLabels.map((l) => ({
        pallet_number: l.pallet_number,
        soc_code: l.soc_code,
        store_code: l.store_code,
        lg_code: l.lg_code,
        volume_no: l.volume_no,
        volume_total: l.volume_total,
        box_count: l.box_count,
        warning: l.warning ?? null,
      })),
      warnings,
      generated_at: new Date().toISOString(),
    };
    let finalizationFailure: unknown = null;
    try {
      const { error: finalizeError } = await supabase.rpc("finalize_label_issuance", {
        p_order_id: order_id,
        p_token: reservationToken,
        p_label_type: "zpl",
        p_storage_path: storagePath,
        p_label_data: labelData,
        p_actor_user_id: actorUserId,
      });
      if (finalizeError) finalizationFailure = finalizeError;
    } catch (finalizationError) {
      finalizationFailure = finalizationError;
    }
    if (finalizationFailure) {
      const failureMessage = finalizationFailure instanceof Error
        ? finalizationFailure.message
        : String((finalizationFailure as { message?: unknown })?.message || finalizationFailure);
      let committedLabel: { id: string } | null = null;
      let reconcileFailure: string | null = null;
      try {
        const { data, error: reconcileError } = await supabase
          .from("labels")
          .select("id")
          .eq("order_id", order_id)
          .eq("pdf_storage_path", storagePath)
          .limit(1)
          .maybeSingle();
        if (reconcileError) reconcileFailure = reconcileError.message;
        else committedLabel = data;
      } catch (error) {
        reconcileFailure = error instanceof Error ? error.message : String(error);
      }
      if (reconcileFailure) {
        console.error("ZPL finalization reconciliation read failed; preserving uploaded object:", reconcileFailure);
        throw new Error(`Falha ao finalizar emissão das etiquetas: ${failureMessage}; resultado incerto, ficheiro mantido para reconciliação`);
      }
      if (!committedLabel) {
        if (isDeterministicFinalizeRejection(finalizationFailure)) {
          try {
            const { error: cleanupError } = await supabase.storage.from("labels").remove([storagePath]);
            if (cleanupError) {
              console.error("ZPL finalization cleanup failed:", cleanupError.message);
            }
          } catch (cleanupError) {
            console.error("ZPL finalization cleanup threw:", cleanupError);
          }
          throw new Error(`Falha ao finalizar emissão das etiquetas: ${failureMessage}`);
        }
        console.error("ZPL finalization outcome uncertain; preserving uploaded object for reconciliation.");
        throw new Error(`Falha ao finalizar emissão das etiquetas: ${failureMessage}; resultado incerto, ficheiro mantido para reconciliação`);
      }
      console.warn("ZPL finalization response failed after label row committed; continuing with committed artifact.");
    }

    const { data: signedUrl, error: urlError } = await supabase.storage
      .from("labels").createSignedUrl(storagePath, 3600);
    if (urlError) throw new Error(`URL falhou: ${urlError.message}`);

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          zpl_url: signedUrl.signedUrl,
          storage_path: storagePath,
          labels_count: allLabels.length,
          order_number: order.order_number,
          zpl_content: fullZpl,
        },
        warnings,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in generate-labels-zpl:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Se a emissão falhar depois de reservar o plano, a reserva é libertada logo; senão a
// encomenda ficava bloqueada e não se podia voltar a fazer as paletes (erro de 30/09).
// Depois de uma emissão bem feita a reserva já não existe e isto não faz nada.
if (import.meta.main) Deno.serve(async (req) => {
  const held: HeldReservation = { orderId: null, token: null };
  const response = await handleRequest(req, held);
  if (held.orderId && held.token) {
    try {
      const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await client.rpc("cancel_plan_issuance", {
        p_order_id: held.orderId,
        p_token: held.token,
      });
      if (error) console.error("Falha a libertar a reserva de emissão:", error.message);
    } catch (error) {
      console.error("Falha a libertar a reserva de emissão:", error);
    }
  }
  return response;
});
