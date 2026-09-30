import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// company_settings (constantes aprovadas pelo cliente)
const SUPPLIER = {
  ean: "5600000034316",
  code: "105299",
  name: "SOCERAMICA-Fabrica de Louça Regional, Lda",
  address: "Travessa do oleiro nº 230",
  postcode: "4750-242",
  city: "BARCELOS",
};

const BUYER = {
  ean: "5600000003022",
  name: "PD - GUARDEIRAS N/P",
  address: "LUGAR DO SETE-VILAR PINHEIRO",
  postcode: "4480-000",
  city: "VILA DO CONDE",
  country: "Portugal",
};

function sanitizeTransportGuide(value: unknown): string {
  return String(value ?? "")
    .replace(/[;\r\n]/g, "")
    .trim()
    .slice(0, 20);
}

const FALLBACK_WAREHOUSE_ADDRESSES: Record<string, WarehouseAddress> = {
  "5531": {
    warehouse_code: "5531",
    warehouse_name: "PD - ALFENA N/P",
    address: "Rua de Nossa Senhora do Amparo EM 6",
    postcode: "4440-000",
    city: "Valongo",
    country: "PT",
  },
  "5405": {
    warehouse_code: "5405",
    warehouse_name: "PD – ALCOCHETE",
    address: "Urb. Passil, Rua B nº 220-Lt-101ª",
    postcode: "2890-171",
    city: "Alcochete",
    country: "PT",
  },
};

function encodeWindows1252(str: string): Uint8Array {
  const cp1252Extra: Record<number, number> = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F,
  };
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7F || (code >= 0xA0 && code <= 0xFF)) bytes.push(code);
    else if (cp1252Extra[code] !== undefined) bytes.push(cp1252Extra[code]);
    else bytes.push(0x3F);
  }
  return new Uint8Array(bytes);
}

function fmtQty(value: number): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(3) : "0.000";
}

function isDeterministicFinalizeRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code || "");
  return new Set(["P0001", "42501", "22004", "22023", "23502", "23503", "23505", "23514", "55000"])
    .has(code);
}

function normalizeText(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .replace(/Ã[\x80-\xBF]|Â[\x80-\xBF]/g, (seq) => {
      // repara UTF-8 duplamente codificado (ex.: "LouÃ§a" -> "Louça")
      try {
        const bytes = Uint8Array.from([...seq].map((c) => c.charCodeAt(0) & 0xFF));
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return seq;
      }
    })
    .normalize("NFC")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/Nï¿½/g, "Nº")
    .replace(/ï¿½/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fixedFields(count: number): string[] {
  return Array(count).fill("");
}

function line(fields: string[]): string {
  return fields.map((v) => normalizeText(v)).join(";");
}

function requireField(errors: string[], condition: unknown, message: string): void {
  if (!condition || String(condition).trim() === "") errors.push(message);
}

function normalizeEan(value: string | null | undefined): string {
  return String(value || "").replace(/\D/g, "");
}

function internalCode18(value: string | null | undefined): string {
  const digits = String(value ?? "").trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 18) return digits.slice(-18);
  return digits.padStart(18, "0");
}

function sanitizeFilename(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_");
}

function normalizeWarehouseCode(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\D/g, "");
}

// Formato obrigatório: YYYY-MM-DDT12:00:00
function toNoonDatetime(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return `${m[1]}T12:00:00`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toISOString().slice(0, 10)}T12:00:00`;
}

function getOrderDate(order: Record<string, unknown>): string {
  return toNoonDatetime(order.order_date || order.issue_date || order.created_at);
}

function getDeliveryDatetime(order: Record<string, unknown>): string {
  return toNoonDatetime(order.delivery_date);
}

interface OrderLine {
  id: string;
  order_id: string;
  article_code: string;
  article_description: string | null;
  quantity: number;
  unit: string | null;
  lg_code: string | null;
  store_code: string | null;
  warehouse_code: string | null;
  quantity_cases: number | null;
  asn_number: string | null;
  asn_item_num: string | null;
  line_number: number;
}

interface Article {
  code: string;
  ean: string | null;
  description: string;
  pieces_per_box: number | null;
}

interface WarehouseAddress {
  warehouse_code: string;
  warehouse_name: string;
  address: string;
  postcode: string;
  city: string;
  country?: string | null;
}

interface DLEntry {
  storeCode: string;
  lgCode: string;
  asnNumber: string;
  asnItemNum: string;
  socCode: string;
  qtyUn: number;
  boxes: number;
  palletItemCount: number;
}

interface DGGroup {
  ean: string;
  articleCode: string;
  internalCode18: string;
  articleDesc: string;
  piecesPerBox: number;
  totalQtyUn: number;
  totalBoxes: number;
  lineNumber: number;
  dlEntries: DLEntry[];
}

async function resolveWarehouseAddress(
  supabase: any,
  warehouseCode: string,
): Promise<WarehouseAddress | null> {
  const { data } = await supabase
    .from("warehouse_addresses")
    .select("warehouse_code, warehouse_name, address, postcode, city, country")
    .eq("warehouse_code", warehouseCode)
    .eq("active", true)
    .maybeSingle();

  if (data) return data as WarehouseAddress;
  return FALLBACK_WAREHOUSE_ADDRESSES[warehouseCode] || null;
}

async function loadInternalCodeMap(
  supabase: any,
  eans: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const cleanEans = [...new Set(eans.map(normalizeEan).filter(Boolean))];

  // Match EXATO por EAN, um a um — sem truncagem nem aproximações
  for (const ean of cleanEans) {
    const { data, error } = await supabase
      .from("pd_internal_article_codes")
      .select("ean, internal_code")
      .eq("ean", ean)
      .eq("active", true)
      .limit(1);
    if (error) throw new Error(`Erro ao ler códigos internos PD (EAN ${ean}): ${error.message}`);
    const row = (data || [])[0] as { ean: string; internal_code: string } | undefined;
    if (!row) continue;
    if (normalizeEan(row.ean) !== ean) {
      throw new Error(
        `Match incorreto de código interno PD: pedido EAN ${ean}, devolvido EAN ${row.ean}`,
      );
    }
    map.set(ean, internalCode18(row.internal_code));
  }

  return map;
}

function lgNumber(value: string | null | undefined): number {
  const n = parseInt(String(value ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : -1;
}

function validateBuiltRecords(
  records: string[][],
  transportGuide: string,
  dlLgOrder: Map<string[], number>,
): string[] {
  const errors: string[] = [];
  const expected: Record<string, number> = { CG: 32, DG: 29, DL: 12, RG: 6 };

  for (const fields of records) {
    const type = fields[0];
    if (!expected[type]) {
      errors.push(`Tipo de registo desconhecido: ${type || "(vazio)"}`);
      continue;
    }
    if (fields.length !== expected[type]) {
      errors.push(`Registo ${type} tem ${fields.length} campos; esperado ${expected[type]}`);
      continue;
    }

    if (type === "CG") {
      if (!fields[1] || !fields[1].trim()) {
        errors.push("CG[1] Guia de Transporte em falta");
      } else if (fields[1] !== transportGuide) {
        errors.push(`CG[1] deve ser ${transportGuide}; recebido ${fields[1]}`);
      } else if (/[;\r\n]/.test(fields[1])) {
        errors.push("CG[1] Guia de Transporte contém caracteres inválidos");
      }
      if (fields[16] !== "Portugal") errors.push(`CG[16] deve ser Portugal; recebido ${fields[16] || "(vazio)"}`);
      requireField(errors, fields[2], "CG[2] data de emissão em falta (data de entrega indicada no modal).");
      requireField(errors, fields[20], "CG[20] data da encomenda em falta. Preencha a data da encomenda no detalhe da encomenda.");
      requireField(errors, fields[21], "CG[21] data de entrega em falta (data indicada no modal).");
      if (fields[2] && !/^\d{4}-\d{2}-\d{2}T12:00:00$/.test(fields[2])) errors.push(`CG[2] formato inválido: ${fields[2]}`);
      if (fields[20] && !/^\d{4}-\d{2}-\d{2}T12:00:00$/.test(fields[20])) errors.push(`CG[20] formato inválido: ${fields[20]}`);
      if (fields[21] && !/^\d{4}-\d{2}-\d{2}T12:00:00$/.test(fields[21])) errors.push(`CG[21] formato inválido: ${fields[21]}`);
      requireField(errors, fields[6], "CG[6] nome do fornecedor em falta");
      requireField(errors, fields[7], "CG[7] morada do fornecedor em falta");
      requireField(errors, fields[8], "CG[8] código postal do fornecedor em falta");
      requireField(errors, fields[9], "CG[9] localidade do fornecedor em falta");
      requireField(errors, fields[12], "CG[12] nome do comprador em falta");
      requireField(errors, fields[13], "CG[13] morada do comprador em falta");
      requireField(errors, fields[14], "CG[14] código postal do comprador em falta");
      requireField(errors, fields[15], "CG[15] localidade do comprador em falta");
      requireField(errors, fields[22], "CG[22] warehouse_code em falta");
      requireField(errors, fields[23], "CG[23] warehouse_name em falta");
      requireField(errors, fields[24], "CG[24] warehouse_address em falta");
      requireField(errors, fields[25], "CG[25] warehouse_postcode em falta");
      requireField(errors, fields[26], "CG[26] warehouse_city em falta");
    }
    if (type === "DG") {
      requireField(errors, fields[5], "DG[5] EAN em falta");
      requireField(errors, fields[6], "DG[6] EAN repetido em falta");
      if (fields[5] !== fields[6]) errors.push(`DG EAN divergente: ${fields[5]} != ${fields[6]}`);
      if (!/^\d{18}$/.test(fields[7] || "")) errors.push(`DG[7] código interno Pingo Doce inválido: ${fields[7] || "(vazio)"}`);
      if (fields[8] !== "EAN") errors.push(`DG[8] deve ser EAN; recebido ${fields[8] || "(vazio)"}`);
      requireField(errors, fields[9], "DG[9] descrição do artigo em falta");
      if (fields[9] && fields[9] !== fields[9].toUpperCase()) errors.push(`DG[9] deve estar em maiúsculas: ${fields[9]}`);
      if (!/^\d+$/.test(fields[3] || "")) errors.push(`DG[3] número de linha inválido: ${fields[3] || "(vazio)"}`);
      if (fields[3] !== fields[4]) errors.push(`DG[3] e DG[4] divergentes: ${fields[3]} != ${fields[4]}`);
    }
    if (type === "DL") {
      requireField(errors, fields[2], "DL[2] store_code em falta");
      requireField(errors, fields[6], "DL[6] asn_item_num em falta");
      requireField(errors, fields[9], "DL[9] asn_number em falta");
      if (!/^SOC\d{6,7}$/.test(fields[10] || "")) {
        errors.push(`DL[10] soc_code inválido: ${fields[10] || "(vazio)"}; esperado SOC seguido de 6 ou 7 dígitos`);
      }
    }
  }

  // Ordem global: DG ascendente por número de linha; DL por LG decrescente dentro de cada DG
  let lastDG = -Infinity;
  let lastDL = Infinity;
  for (const fields of records) {
    if (fields[0] === "DG") {
      const n = Number(fields[3]);
      if (n <= lastDG) errors.push(`DG fora de ordem: linha ${fields[3]} após ${lastDG}`);
      lastDG = n;
      lastDL = Infinity;
    } else if (fields[0] === "DL") {
      const v = dlLgOrder.get(fields) ?? -1;
      if (v > lastDL) errors.push(`DL fora de ordem: LG ${v} após LG ${lastDL} (loja ${fields[2]})`);
      lastDL = v;
    }
  }

  return errors;
}

interface HeldReservation {
  orderId: string | null;
  token: string | null;
}

async function handleRequest(req: Request, held: HeldReservation): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let currentStep = "init";
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const denied = await requireRole(req, supabase, ["admin", "operador"], corsHeaders);
    if (denied) return denied;

    const authHeader = req.headers.get("Authorization") || "";
    const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!bearerMatch) {
      return new Response(JSON.stringify({ success: false, error: "Não autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: authenticatedUser, error: authenticatedUserError } =
      await supabase.auth.getUser(bearerMatch[1]);
    if (authenticatedUserError || !authenticatedUser.user) {
      return new Response(JSON.stringify({ success: false, error: "Não autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const performedBy = authenticatedUser.user.id;

    const { order_id, transport_guide, delivery_date } = await req.json();
    if (!order_id) {
      return new Response(JSON.stringify({ success: false, error: "order_id é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (typeof order_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order_id)) {
      return new Response(JSON.stringify({ success: false, error: "order_id inválido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const transportGuide = sanitizeTransportGuide(transport_guide);
    const providedDeliveryDate = String(delivery_date ?? "").trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
    if (!transportGuide || !providedDeliveryDate) {
      return new Response(JSON.stringify({
        success: false,
        error: "Guia de Transporte e Data de Entrega são obrigatórios.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (Number.isNaN(new Date(`${providedDeliveryDate}T12:00:00`).getTime())) {
      return new Response(JSON.stringify({ success: false, error: "Data de Entrega inválida." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reserve before reading the order/plan or mutating delivery data. A
    // reservation remains until finalization or the next issuer replaces it
    // after ten minutes. Never release an uncertain issuance here.
    // Regra de alteração: entregue = fechada; ficheiro já gerado = só administrador.
    const { data: changeBlock, error: changeBlockError } = await supabase
      .rpc("order_change_block_reason", { p_order_id: order_id, p_actor_user_id: performedBy });
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

    currentStep = "load_order";
    console.log("DESADV step:", currentStep, { order_id });
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*")
      .eq("id", order_id)
      .single();
    if (orderErr || !order) throw new Error(`Encomenda não encontrada: ${orderErr?.message || order_id}`);

    // The finalizer persists this value atomically; use it locally while building.
    (order as Record<string, unknown>).delivery_date = providedDeliveryDate;



    currentStep = "load_lines";
    console.log("DESADV step:", currentStep, { order_id });
    const { data: rawLines, error: linesErr } = await supabase
      .from("order_lines")
      .select("*")
      .eq("order_id", order_id)
      .order("line_number", { ascending: true });
    if (linesErr) throw new Error(`Erro ao buscar linhas: ${linesErr.message}`);

    const lines = (rawLines || []) as OrderLine[];
    if (lines.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "Nenhuma linha de encomenda encontrada" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const articleCodes = [...new Set(lines.map((l) => l.article_code).filter(Boolean))];
    currentStep = "load_pd_codes";
    console.log("DESADV step:", currentStep, { articles: articleCodes.length });
    const { data: rawArticles } = await supabase
      .from("articles")
      .select("code, ean, description, pieces_per_box")
      .in("code", articleCodes);

    const articleMap = new Map<string, Article>();
    for (const article of (rawArticles || []) as Article[]) articleMap.set(article.code, article);

    const resolvedEans = lines.map((l) => normalizeEan(articleMap.get(l.article_code)?.ean || l.article_code));
    const internalCodeMap = await loadInternalCodeMap(supabase, resolvedEans);

    currentStep = "load_soc";
    console.log("DESADV step:", currentStep, { order_id });
    const { data: rawPlans, error: plansErr } = await supabase
      .from("palletization_plans")
      .select("id, pallet_number, soc_code")
      .eq("order_id", order_id)
      .order("pallet_number", { ascending: true });
    if (plansErr) throw new Error(`Erro ao buscar paletes: ${plansErr.message}`);

    const plans = (rawPlans || []) as Array<{ id: string; pallet_number: number; soc_code: string | null }>;
    const planIds = plans.map((p) => p.id);
    const lineSocMap = new Map<string, Set<string>>();
    const lineBoxesBySoc = new Map<string, number>();
    const containerBoxesByLineSoc = new Map<string, number>();
    const palletItemCountByLineSoc = new Map<string, number>();
    // SOC próprio de cada caixa (planos gravados com um SOC por caixa).
    const perBoxSocs = new Set<string>();
    const containerMappingErrors: string[] = [];

    if (planIds.length > 0) {
      const pageSize = 1000;
      const { count: itemCount, error: itemCountErr } = await supabase
        .from("pallet_items")
        .select("id", { count: "exact", head: true })
        .in("palletization_plan_id", planIds);
      if (itemCountErr) {
        throw new Error(`Erro ao contar itens de palete: ${itemCountErr.message}`);
      }
      if (itemCount == null) {
        throw new Error("Não foi possível confirmar o número de itens de palete");
      }

      const rawItems: Array<{
        order_line_id: string | null;
        palletization_plan_id: string;
        box_number: number | null;
        store_code: string | null;
        soc_code?: string | null;
      }> = [];
      if (itemCount < pageSize) {
        const { data, error } = await supabase
          .from("pallet_items")
          .select("order_line_id, palletization_plan_id, box_number, store_code, soc_code")
          .in("palletization_plan_id", planIds);
        if (error) throw new Error(`Erro ao buscar itens de palete: ${error.message}`);
        if (!data || data.length !== itemCount) {
          throw new Error(
            `Leitura incompleta de itens de palete: esperados ${itemCount}, recebidos ${data?.length ?? 0}`,
          );
        }
        rawItems.push(...data);
      } else {
        for (let offset = 0; offset < itemCount;) {
          const pageEnd = Math.min(offset + pageSize, itemCount) - 1;
          const { data, error } = await supabase
            .from("pallet_items")
            .select("id, order_line_id, palletization_plan_id, box_number, store_code, soc_code")
            .in("palletization_plan_id", planIds)
            .order("id", { ascending: true })
            .range(offset, pageEnd);
          if (error) throw new Error(`Erro ao paginar itens de palete: ${error.message}`);
          const expectedRows = pageEnd - offset + 1;
          if (!data || data.length !== expectedRows) {
            throw new Error(
              `Leitura incompleta de itens de palete: esperados ${expectedRows} na posição ${offset}, recebidos ${data?.length ?? 0}`,
            );
          }
          rawItems.push(...data);
          offset += data.length;
        }
      }

      const planMap = new Map<string, { socCode: string; palletNumber: number }>();
      for (const p of plans) {
        planMap.set(p.id, { socCode: String(p.soc_code || "").trim(), palletNumber: p.pallet_number });
      }

      const orderLineById = new Map(lines.map((orderLine) => [orderLine.id, orderLine]));
      const { count: containerCount, error: containerCountErr } = await supabase
        .from("pallet_store_containers")
        .select("palletization_plan_id", { count: "exact", head: true })
        .in("palletization_plan_id", planIds);
      if (containerCountErr) {
        throw new Error(`Erro ao contar contentores SOC por loja: ${containerCountErr.message}`);
      }
      if (containerCount == null) {
        throw new Error("Não foi possível confirmar o número de contentores SOC por loja");
      }

      const rawContainers: Array<{
        palletization_plan_id: string;
        store_code: string;
        soc_code: string;
      }> = [];
      if (containerCount < pageSize) {
        const { data, error } = await supabase
          .from("pallet_store_containers")
          .select("palletization_plan_id, store_code, soc_code")
          .in("palletization_plan_id", planIds);
        if (error) {
          throw new Error(`Erro ao buscar contentores SOC por loja: ${error.message}`);
        }
        if (!data || data.length !== containerCount) {
          throw new Error(
            `Leitura incompleta de contentores SOC por loja: esperados ${containerCount}, recebidos ${data?.length ?? 0}`,
          );
        }
        rawContainers.push(...data);
      } else {
        for (let offset = 0; offset < containerCount;) {
          const pageEnd = Math.min(offset + pageSize, containerCount) - 1;
          const { data, error } = await supabase
            .from("pallet_store_containers")
            .select("palletization_plan_id, store_code, soc_code")
            .in("palletization_plan_id", planIds)
            .order("palletization_plan_id", { ascending: true })
            .order("store_code", { ascending: true })
            .range(offset, pageEnd);
          if (error) {
            throw new Error(`Erro ao paginar contentores SOC por loja: ${error.message}`);
          }
          const expectedRows = pageEnd - offset + 1;
          if (!data || data.length !== expectedRows) {
            throw new Error(
              `Leitura incompleta de contentores SOC por loja: esperados ${expectedRows} na posição ${offset}, recebidos ${data?.length ?? 0}`,
            );
          }
          rawContainers.push(...data);
          offset += data.length;
        }
      }

      const containersByPlan = new Map<string, Map<string, string>>();
      const plansWithContainers = new Set<string>();
      for (const container of rawContainers) {
        plansWithContainers.add(container.palletization_plan_id);
        const storeCode = String(container.store_code || "").trim();
        const socCode = String(container.soc_code || "").trim();
        if (!storeCode || !socCode) {
          containerMappingErrors.push(
            `Contentor SOC inválido no palete ${planMap.get(container.palletization_plan_id)?.palletNumber ?? container.palletization_plan_id}`,
          );
          continue;
        }
        if (!containersByPlan.has(container.palletization_plan_id)) {
          containersByPlan.set(container.palletization_plan_id, new Map());
        }
        containersByPlan.get(container.palletization_plan_id)!.set(storeCode, socCode);
      }

      for (const item of rawItems) {
        if (!item.order_line_id) continue;
        const plan = planMap.get(item.palletization_plan_id);

        const boxSoc = String(item.soc_code || "").trim();
        if (boxSoc) {
          const orderLine = orderLineById.get(item.order_line_id);
          if (!orderLine) {
            containerMappingErrors.push(
              `Item de palete sem linha de encomenda correspondente no palete ${plan?.palletNumber ?? item.palletization_plan_id}`,
            );
            continue;
          }
          const itemStoreCode = String(item.store_code || "").trim();
          const orderStoreCode = String(orderLine.store_code || "").trim();
          if (itemStoreCode && orderStoreCode && itemStoreCode !== orderStoreCode) {
            containerMappingErrors.push(
              `Loja divergente no palete ${plan?.palletNumber ?? item.palletization_plan_id}, linha ${orderLine.line_number}: item ${itemStoreCode}, encomenda ${orderStoreCode}`,
            );
            continue;
          }
          if (perBoxSocs.has(boxSoc)) {
            containerMappingErrors.push(`SOC ${boxSoc} repetido em mais de uma caixa`);
            continue;
          }
          perBoxSocs.add(boxSoc);
          if (!lineSocMap.has(item.order_line_id)) lineSocMap.set(item.order_line_id, new Set());
          lineSocMap.get(item.order_line_id)!.add(boxSoc);
          const lineSocKey = `${item.order_line_id}|${boxSoc}`;
          containerBoxesByLineSoc.set(lineSocKey, 1);
          palletItemCountByLineSoc.set(lineSocKey, 1);
          continue;
        }

        if (plansWithContainers.has(item.palletization_plan_id)) {
          const orderLine = orderLineById.get(item.order_line_id);
          if (!orderLine) {
            containerMappingErrors.push(
              `Item de palete sem linha de encomenda correspondente no palete ${plan?.palletNumber ?? item.palletization_plan_id}`,
            );
            continue;
          }

          const itemStoreCode = String(item.store_code || "").trim();
          const orderStoreCode = String(orderLine.store_code || "").trim();
          if (itemStoreCode && orderStoreCode && itemStoreCode !== orderStoreCode) {
            containerMappingErrors.push(
              `Loja divergente no palete ${plan?.palletNumber ?? item.palletization_plan_id}, linha ${orderLine.line_number}: item ${itemStoreCode}, encomenda ${orderStoreCode}`,
            );
            continue;
          }
          const storeCode = orderStoreCode || itemStoreCode;
          if (!storeCode) {
            containerMappingErrors.push(
              `store_code ausente no palete ${plan?.palletNumber ?? item.palletization_plan_id}, linha ${orderLine.line_number}`,
            );
            continue;
          }

          const socCode = containersByPlan.get(item.palletization_plan_id)?.get(storeCode);
          if (!socCode) {
            containerMappingErrors.push(
              `Contentor SOC em falta para a loja ${storeCode} no palete ${plan?.palletNumber ?? item.palletization_plan_id}`,
            );
            continue;
          }

          if (!lineSocMap.has(item.order_line_id)) lineSocMap.set(item.order_line_id, new Set());
          lineSocMap.get(item.order_line_id)!.add(socCode);
          const lineSocKey = `${item.order_line_id}|${socCode}`;
          const itemBoxes = Math.max(1, Number(item.box_number || 1));
          containerBoxesByLineSoc.set(
            lineSocKey,
            (containerBoxesByLineSoc.get(lineSocKey) || 0) + itemBoxes,
          );
          palletItemCountByLineSoc.set(
            lineSocKey,
            (palletItemCountByLineSoc.get(lineSocKey) || 0) + 1,
          );
          continue;
        }

        if (!plan?.socCode) continue;
        if (!lineSocMap.has(item.order_line_id)) lineSocMap.set(item.order_line_id, new Set());
        lineSocMap.get(item.order_line_id)!.add(plan.socCode);
        const lineSocKey = `${item.order_line_id}|${plan.socCode}`;
        lineBoxesBySoc.set(lineSocKey, Math.max(1, Number(item.box_number || 1)));
        palletItemCountByLineSoc.set(
          lineSocKey,
          (palletItemCountByLineSoc.get(lineSocKey) || 0) + 1,
        );
      }

      for (const [lineSocKey, boxes] of containerBoxesByLineSoc) {
        lineBoxesBySoc.set(lineSocKey, boxes);
      }
    }

    const errors: string[] = [...containerMappingErrors];
    const warnings: string[] = [];
    currentStep = "load_warehouse_addr";
    console.log("DESADV step:", currentStep);
    const orderRec = order as Record<string, unknown>;
    const warehouseCode = normalizeWarehouseCode(
      lines.find((l) => l.warehouse_code)?.warehouse_code ||
        (orderRec.warehouse_code as string | null) ||
        (orderRec.delivery_site_code as string | null) ||
        "",
    );
    const warehouse = warehouseCode ? await resolveWarehouseAddress(supabase, warehouseCode) : null;
    if (!warehouseCode) {
      errors.push(
        "warehouse_code (entreposto) ausente na encomenda — não é possível preencher o registo CG",
      );
    }
    if (warehouseCode && !warehouse) errors.push(`Morada do entreposto ${warehouseCode} em falta em warehouse_addresses`);

    const dgMap = new Map<string, DGGroup>();

    currentStep = "build_dg";
    console.log("DESADV step:", currentStep, { lines: lines.length });
    for (const orderLine of lines) {
      const art = articleMap.get(orderLine.article_code);
      const ean = normalizeEan(art?.ean || orderLine.article_code);
      const piecesPerBox = Math.max(1, Number(art?.pieces_per_box || 1));
      const internalPdCode = internalCodeMap.get(ean) || "";
      const lineQty = Number(orderLine.quantity || 0);
      const lineBoxes = orderLine.quantity_cases != null
        ? Math.ceil(Number(orderLine.quantity_cases))
        : Math.ceil(lineQty / piecesPerBox);

      if (!ean) errors.push(`Linha ${orderLine.line_number} (${orderLine.article_code}): EAN ausente`);
      if (!String(orderLine.article_description || "").trim()) {
        errors.push(`Linha ${orderLine.line_number} (${orderLine.article_code}): descrição do artigo (do XML) ausente`);
      }
      if (!internalPdCode) errors.push(`Linha ${orderLine.line_number} (${orderLine.article_code}, EAN ${ean || "?"}): código interno Pingo Doce ausente`);

      const mapKey = ean || orderLine.article_code;
      if (!dgMap.has(mapKey)) {
        dgMap.set(mapKey, {
          ean,
          articleCode: orderLine.article_code,
          internalCode18: internalPdCode,
          articleDesc: String(orderLine.article_description || "").toUpperCase(),
          piecesPerBox,
          totalQtyUn: 0,
          totalBoxes: 0,
          lineNumber: Number(orderLine.line_number || 0),
          dlEntries: [],
        });
      }

      const dg = dgMap.get(mapKey)!;
      dg.totalQtyUn += lineQty;
      dg.totalBoxes += lineBoxes;
      if (!dg.internalCode18 && internalPdCode) dg.internalCode18 = internalPdCode;
      if (!dg.articleDesc && orderLine.article_description) dg.articleDesc = String(orderLine.article_description).toUpperCase();
      if (orderLine.line_number && orderLine.line_number < dg.lineNumber) dg.lineNumber = orderLine.line_number;

      const storeCode = String(orderLine.store_code || "").trim();
      const lgCode = String(orderLine.lg_code || "").trim();
      const asnNumber = String(orderLine.asn_number || "").trim();
      const asnItemNum = String(orderLine.asn_item_num || "").trim();
      const socCodes = [...(lineSocMap.get(orderLine.id) || new Set<string>())].filter(Boolean).sort();

      if (!storeCode) errors.push(`Linha ${orderLine.line_number} (${orderLine.article_code}): store_code ausente`);
      if (!asnNumber) errors.push(`Linha ${orderLine.line_number} (${orderLine.article_code}): asn_number ausente — não conforme com template do cliente`);
      if (!asnItemNum) errors.push(`Linha ${orderLine.line_number} (${orderLine.article_code}): asn_item_num ausente — não conforme com template do cliente`);
      if (socCodes.length === 0) errors.push(`Linha ${orderLine.line_number} (${orderLine.article_code}): soc_code ausente — gere etiquetas/paletes antes do DESADV`);

      const boxesPerSoc = socCodes.length > 0
        ? socCodes.map((soc) => ({
          soc,
          boxes: Math.max(1, lineBoxesBySoc.get(`${orderLine.id}|${soc}`) || Math.ceil(lineBoxes / socCodes.length)),
          palletItemCount: palletItemCountByLineSoc.get(`${orderLine.id}|${soc}`) || 0,
        }))
        : [];
      const totalMappedBoxes = boxesPerSoc.reduce((sum, item) => sum + item.boxes, 0) || 1;
      // Um SOC por caixa: cada caixa leva as peças de uma caixa cheia e a última leva o resto
      // (ex.: 50 peças, 12 por caixa → 12, 12, 12, 12, 2). Numa palete completa o SOC da
      // palete leva as caixas cheias todas (ex.: 3 caixas → 36) e o resto segue igual.
      const allPerBox = boxesPerSoc.length > 0 && boxesPerSoc.every((item) => perBoxSocs.has(item.soc));
      const fullBoxesBeforeLast = boxesPerSoc.slice(0, -1)
        .reduce((sum, item) => sum + item.boxes * piecesPerBox, 0);
      const sequential = allPerBox || (boxesPerSoc.length > 1 && fullBoxesBeforeLast < lineQty);
      let remainingQty = lineQty;

      for (const [socIndex, { soc, boxes, palletItemCount }] of boxesPerSoc.entries()) {
        let qtyForSoc: number;
        if (sequential) {
          const isLast = socIndex === boxesPerSoc.length - 1;
          qtyForSoc = isLast ? remainingQty : Math.min(boxes * piecesPerBox, remainingQty);
          remainingQty -= qtyForSoc;
        } else {
          qtyForSoc = socCodes.length === 1 ? lineQty : lineQty * (boxes / totalMappedBoxes);
        }
        dg.dlEntries.push({
          storeCode,
          lgCode,
          asnNumber,
          asnItemNum,
          socCode: soc,
          qtyUn: qtyForSoc,
          boxes,
          palletItemCount,
        });
      }
    }

    for (const dg of dgMap.values()) {
      const agg = new Map<string, DLEntry>();
      for (const dl of dg.dlEntries) {
        const key = `${dl.storeCode}|${dl.asnItemNum}|${dl.asnNumber}|${dl.socCode}`;
        const current = agg.get(key);
        if (current) {
          current.qtyUn += dl.qtyUn;
          current.boxes += dl.boxes;
          current.palletItemCount += dl.palletItemCount;
        } else {
          agg.set(key, { ...dl });
        }
      }
      // Ordem das DL exigida pelo Pingo Doce: LG do maior para o menor (sequência do layout do armazém);
      // empate: loja decrescente, depois SOC crescente.
      dg.dlEntries = [...agg.values()].sort((a, b) => {
        const la = lgNumber(a.lgCode);
        const lb = lgNumber(b.lgCode);
        if (la !== lb) return lb - la;
        const sa = parseInt(a.storeCode, 10) || 0;
        const sb = parseInt(b.storeCode, 10) || 0;
        if (sa !== sb) return sb - sa;
        return a.socCode.localeCompare(b.socCode, "pt", { numeric: true });
      });
    }

    if (errors.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "DESADV não conforme com template do cliente",
        validation_errors: errors,
        warnings,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const records: string[][] = [];
    const dlLgOrder = new Map<string[], number>();
    currentStep = "build_cg";
    console.log("DESADV step:", currentStep);
    const deliveryDatetime = getDeliveryDatetime(order as Record<string, unknown>);
    const orderDatetime = getOrderDate(order as Record<string, unknown>);
    const docDatetime = deliveryDatetime; // CG[2] = CG[21] (data de entrega)

    const cg = fixedFields(32);
    cg[0] = "CG";
    cg[1] = transportGuide;
    cg[2] = docDatetime;
    cg[4] = SUPPLIER.ean;
    cg[5] = SUPPLIER.code;
    cg[6] = SUPPLIER.name;
    cg[7] = SUPPLIER.address;
    cg[8] = SUPPLIER.postcode;
    cg[9] = SUPPLIER.city;
    cg[11] = BUYER.ean;
    cg[12] = BUYER.name;
    cg[13] = BUYER.address;
    cg[14] = BUYER.postcode;
    cg[15] = BUYER.city;
    cg[16] = BUYER.country;
    cg[18] = "1";
    cg[19] = String((order as Record<string, unknown>).order_number || "");
    cg[20] = orderDatetime;
    cg[21] = deliveryDatetime;
    cg[22] = warehouse!.warehouse_code;
    cg[23] = warehouse!.warehouse_name;
    cg[24] = warehouse!.address;
    cg[25] = warehouse!.postcode;
    cg[26] = warehouse!.city;
    cg[28] = "EUR";
    records.push(cg);

    const dgList = [...dgMap.values()];
    const missingLineNumbers = dgList.some((d) => !d.lineNumber);
    if (missingLineNumbers) {
      // Dados antigos sem line_number: sequencial 10, 20, 30... pela ordem de aparecimento
      dgList.forEach((d, idx) => { if (!d.lineNumber) d.lineNumber = (idx + 1) * 10; });
      warnings.push("Encomenda sem números de linha originais — usada numeração sequencial 10, 20, 30...");
    }
    const sortedDGs = dgList.sort((a, b) => {
      if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
      return a.ean.localeCompare(b.ean, "pt", { numeric: true });
    });

    let countDG = 0;
    let countDL = 0;
    currentStep = "build_dl";
    console.log("DESADV step:", currentStep, { groups: sortedDGs.length });
    for (let i = 0; i < sortedDGs.length; i++) {
      const dg = sortedDGs[i];
      countDG++;
      const lineNo = dg.lineNumber || (i + 1) * 10;
      void i;

      const dgFields = fixedFields(29);
      dgFields[0] = "DG";
      dgFields[1] = "1";
      dgFields[3] = String(lineNo);
      dgFields[4] = String(lineNo);
      dgFields[5] = dg.ean;
      dgFields[6] = dg.ean;
      dgFields[7] = dg.internalCode18;
      dgFields[8] = "EAN";
      dgFields[9] = String(dg.articleDesc || "").toUpperCase();
      dgFields[10] = fmtQty(dg.totalQtyUn);
      dgFields[11] = "UN";
      dgFields[12] = "0.000";
      dgFields[13] = fmtQty(dg.piecesPerBox);
      dgFields[14] = "UN";
      dgFields[18] = String(
        dg.dlEntries.reduce((sum, dl) => sum + dl.palletItemCount, 0),
      );
      dgFields[24] = "2001-01-01T12:00:00";
      records.push(dgFields);

      for (const dl of dg.dlEntries) {
        countDL++;
        const dlFields = fixedFields(12);
        dlFields[0] = "DL";
        dlFields[2] = dl.storeCode;
        dlFields[6] = dl.asnItemNum;
        dlFields[7] = fmtQty(dl.qtyUn);
        dlFields[8] = "UN";
        dlFields[9] = dl.asnNumber;
        dlFields[10] = dl.socCode;
        dlFields[11] = String(dl.palletItemCount);
        dlLgOrder.set(dlFields, lgNumber(dl.lgCode));
        records.push(dlFields);
      }
    }

    const rg = fixedFields(6);
    currentStep = "build_rg";
    rg[0] = "RG";
    rg[1] = String(countDG);
    records.push(rg);

    const validationErrors = validateBuiltRecords(records, transportGuide, dlLgOrder);
    if (validationErrors.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "DESADV não conforme com template do cliente",
        validation_errors: validationErrors,
        warnings,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    currentStep = "encode_cp1252";
    console.log("DESADV step:", currentStep, { records: records.length });
    const csvContent = records.map(line).join("\r\n") + "\r\n";
    const encoded = encodeWindows1252(csvContent);
    if (encoded.length !== csvContent.length) {
      throw new Error("Falha de codificação CP1252: número de bytes diferente do número de caracteres");
    }
    const encodingWarning: string | null = null;

    currentStep = "upload_storage";
    const filename = sanitizeFilename(`DESADV_CD_802_${order.order_number}_GT${transportGuide}.csv`);
    const storagePath = `${order_id}/${crypto.randomUUID()}/${filename}`;
    console.log("DESADV step:", currentStep, { storagePath, bytes: encoded.length });

    const { data: bucket } = await supabase.storage.getBucket("exports");
    if (!bucket) {
      const { error: bucketErr } = await supabase.storage.createBucket("exports", { public: false });
      if (bucketErr) console.error("DESADV createBucket:", bucketErr.message);
    }

    const { error: uploadErr } = await supabase.storage
      .from("exports")
      .upload(storagePath, encoded, {
        contentType: encodingWarning ? "text/csv; charset=utf-8" : "text/csv; charset=windows-1252",
        upsert: false,
      });
    if (uploadErr) {
      return new Response(JSON.stringify({
        success: false,
        error: `Falha ao gravar ficheiro: ${uploadErr.message}`,
        step: "upload_storage",
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    currentStep = "finalize_desadv";
    try {
      const { error: finalizeError } = await supabase.rpc("finalize_desadv_issuance", {
        p_order_id: order_id,
        p_token: reservationToken,
        p_actor_user_id: performedBy,
        p_transport_guide: transportGuide,
        p_delivery_date: providedDeliveryDate,
        p_storage_path: storagePath,
        p_filename: filename,
        p_count_dg: countDG,
        p_count_dl: countDL,
      });
      if (finalizeError) throw finalizeError;
    } catch (finalizationError) {
      const failureMessage = finalizationError instanceof Error
        ? finalizationError.message
        : String((finalizationError as { message?: unknown })?.message || finalizationError);
      let committedDesadv: { id: string } | null = null;
      let reconcileFailure: string | null = null;
      try {
        const { data, error: reconcileError } = await supabase
          .from("operation_history")
          .select("id")
          .eq("entity_type", "order")
          .eq("entity_id", order_id)
          .in("action", ["desadv_generated", "desadv_regenerated"])
          .eq("details->>storage_path", storagePath)
          .limit(1)
          .maybeSingle();
        if (reconcileError) reconcileFailure = reconcileError.message;
        else committedDesadv = data;
      } catch (error) {
        reconcileFailure = error instanceof Error ? error.message : String(error);
      }
      if (reconcileFailure) {
        console.error("DESADV finalization reconciliation read failed; preserving uploaded object:", reconcileFailure);
        throw new Error(`Falha ao finalizar emissão do DESADV: ${failureMessage}; resultado incerto, ficheiro mantido para reconciliação`);
      }
      if (!committedDesadv) {
        if (isDeterministicFinalizeRejection(finalizationError)) {
          try {
            const { error: cleanupError } = await supabase.storage.from("exports").remove([storagePath]);
            if (cleanupError) {
              console.error("DESADV finalization cleanup failed:", cleanupError.message);
            }
          } catch (cleanupError) {
            console.error("DESADV finalization cleanup threw:", cleanupError);
          }
          throw new Error(`Falha ao finalizar emissão do DESADV: ${failureMessage}`);
        }
        console.error("DESADV finalization outcome uncertain; preserving uploaded object for reconciliation.");
        throw new Error(`Falha ao finalizar emissão do DESADV: ${failureMessage}; resultado incerto, ficheiro mantido para reconciliação`);
      }
      console.warn("DESADV finalization response failed after history row committed; continuing with committed artifact.");
    }

    currentStep = "sign_url";
    const { data: signedUrl, error: urlErr } = await supabase.storage
      .from("exports")
      .createSignedUrl(storagePath, 3600);
    if (urlErr) throw new Error(`URL falhou: ${urlErr.message}`);

    return new Response(JSON.stringify({
      success: true,
      warning: encodingWarning || undefined,
      data: {
        desadv_url: signedUrl.signedUrl,
        storage_path: storagePath,
        filename,
        transport_guide: transportGuide,
        checks: {
          cg_fields: 32,
          cg_transport_guide: transportGuide,
          cg_country: BUYER.country,
          cg_delivery_datetime: deliveryDatetime,
          cg_order_datetime: orderDatetime,
          dg_ordered_by_xml_line: true,
          dl_ordered_by_asn_item_num: true,
          encoding: "windows-1252",
          bytes: encoded.length,
        },
        count_dg: countDG,
        count_dl: countDL,
        order_number: order.order_number,
        warnings: warnings.length ? warnings : undefined,
      },
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const err = error as { message?: string; name?: string; stack?: string };
    console.error("DESADV crash:", {
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
      step: currentStep,
    });
    return new Response(JSON.stringify({
      success: false,
      error: err?.message || "Erro interno",
      step: currentStep,
      stack: err?.stack,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// Se a emissão falhar depois de reservar o plano, a reserva é libertada logo; senão a
// encomenda ficava bloqueada e não se podia voltar a fazer as paletes (erro de 30/09).
// Depois de uma emissão bem feita a reserva já não existe e isto não faz nada.
Deno.serve(async (req) => {
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
