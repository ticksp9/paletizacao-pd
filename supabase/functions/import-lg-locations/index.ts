import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { read, utils } from "npm:xlsx@0.18.5";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface LgRow {
  company_id: string;
  warehouse_code: string;
  location_id: string;
  lg_number: string;
  store_code: string | null;
  supermarket_name: string | null;
  city_label: string | null;
  customer_label: string | null;
  name: string | null;
  delivery_internal_code: string | null;
}

// Normalize location_id: ensure "LG" prefix. Returns null if no digits found.
function normalizeLg(raw: string): { location_id: string; lg_number: string } | null {
  const cleaned = String(raw).trim();
  // Must contain at least one digit to be valid
  if (!/\d/.test(cleaned)) return null;
  const match = cleaned.match(/^(?:LG)?(\d+)$/i);
  if (!match) {
    // Try extracting digits from mixed text like "LG 3640" or "LG-3640"
    const digits = cleaned.replace(/\D/g, "");
    if (!digits) return null;
    return { location_id: `LG${digits}`, lg_number: digits };
  }
  return { location_id: `LG${match[1]}`, lg_number: match[1] };
}

// Flexible header mapping
function mapHeader(h: string): string | null {
  const lower = h.toLowerCase().trim().replace(/[_\s-]+/g, "");
  if (!lower) return null;
  const map: Record<string, string> = {
    // warehouse
    warehousecode: "warehouse_code",
    warehouse: "warehouse_code",
    armazem: "warehouse_code",
    armazém: "warehouse_code",
    codigoarmazem: "warehouse_code",
    // company
    companyid: "company_id",
    company: "company_id",
    empresa: "company_id",
    // LG / location columns
    locationid: "location_id",
    location: "location_id",
    lg: "location_id",
    lgcode: "location_id",
    codigolg: "location_id",
    local: "location_id",
    localizacao: "location_id",
    localização: "location_id",
    lgnumber: "lg_number",
    // store
    storecode: "store_code",
    store: "store_code",
    loja: "store_code",
    codigoloja: "store_code",
    nrloja: "store_code",
    numeroloja: "store_code",
    // supermarket name
    supermarketname: "supermarket_name",
    supermarket: "supermarket_name",
    nomesupermercado: "supermarket_name",
    // city
    city: "city_label",
    citylabel: "city_label",
    cidade: "city_label",
    localidade: "city_label",
    // customer
    customerlabel: "customer_label",
    customer: "customer_label",
    cliente: "customer_label",
    textocliente: "customer_label",
    designacao: "customer_label",
    designação: "customer_label",
    // name / description
    name: "name",
    nome: "name",
    descricao: "name",
    descrição: "name",
    description: "name",
    // delivery / warehouse code (legacy)
    deliveryinternalcode: "delivery_internal_code",
    deliverycode: "delivery_internal_code",
    internalcode: "delivery_internal_code",
    codigointerno: "delivery_internal_code",
    codigoentrega: "delivery_internal_code",
  };
  return map[lower] || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    const authResponse = await requireRole(req, supabase, "admin", corsHeaders);
    if (authResponse) return authResponse;

    const { storage_path } = await req.json();

    if (!storage_path) {
      return new Response(
        JSON.stringify({ success: false, error: "storage_path é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Download file
    const { data: fileData, error: dlError } = await supabase.storage
      .from("masterdata")
      .download(storage_path);

    if (dlError || !fileData) {
      return new Response(
        JSON.stringify({ success: false, error: `Erro ao ler ficheiro: ${dlError?.message}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const buffer = await fileData.arrayBuffer();
    const wb = read(new Uint8Array(buffer), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rawRows: Record<string, unknown>[] = utils.sheet_to_json(sheet, { defval: "" });

    if (rawRows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Ficheiro vazio ou sem dados" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Identify columns
    const sampleKeys = Object.keys(rawRows[0]);
    console.log("Colunas encontradas:", JSON.stringify(sampleKeys));

    const headerMap: Record<string, string> = {};
    let lgColumnKey: string | null = null;

    for (const key of sampleKeys) {
      const mapped = mapHeader(key);
      if (mapped) {
        headerMap[key] = mapped;
        if (mapped === "location_id") lgColumnKey = key;
      }
    }

    // Fallback: find column with LG-like values
    if (!lgColumnKey) {
      const lgCandidate = sampleKeys.find((key) => {
        const val = String(rawRows[0][key] || "").trim();
        return /^(?:LG)?\d{2,}$/i.test(val);
      });
      if (lgCandidate) {
        console.log(`Fallback LG: coluna "${lgCandidate}"`);
        headerMap[lgCandidate] = "location_id";
        lgColumnKey = lgCandidate;
      }
    }

    console.log("Mapeamento:", JSON.stringify(headerMap));

    if (!lgColumnKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Ficheiro não contém coluna de LG reconhecível. Colunas: ${sampleKeys.join(", ")}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if warehouse_code column was found
    const hasWarehouse = Object.values(headerMap).includes("warehouse_code");

    // Process rows
    const rows: LgRow[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    let skippedNoLg = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const rawLgValue = String(raw[lgColumnKey] || "").trim();

      // Skip empty, header-like ("LG"), or non-numeric values silently
      if (!rawLgValue || !/\d/.test(rawLgValue)) {
        skippedNoLg++;
        continue;
      }

      const normalized = normalizeLg(rawLgValue);

      if (!normalized) {
        skippedNoLg++;
        continue;
      }

      const { location_id, lg_number } = normalized;

      // Map remaining columns
      const mapped: Record<string, string> = {};
      for (const [origKey, targetKey] of Object.entries(headerMap)) {
        if (targetKey !== "location_id") {
          mapped[targetKey] = String(raw[origKey] || "").trim();
        }
      }

      // If lg_number came as a separate column, use it; otherwise use normalized
      const finalLgNumber = mapped.lg_number || lg_number;

      rows.push({
        company_id: mapped.company_id || "01",
        warehouse_code: mapped.warehouse_code || "",
        location_id,
        lg_number: finalLgNumber,
        store_code: mapped.store_code || null,
        supermarket_name: mapped.supermarket_name || null,
        city_label: mapped.city_label || null,
        customer_label: mapped.customer_label || null,
        name: mapped.name || null,
        delivery_internal_code: mapped.delivery_internal_code || null,
      });
    }

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Nenhuma linha válida encontrada", errors }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Deduplicate by (company_id, warehouse_code, location_id) — keep last occurrence
    const deduped = new Map<string, LgRow>();
    for (const row of rows) {
      const key = `${row.company_id}||${row.warehouse_code}||${row.location_id}`;
      deduped.set(key, row);
    }
    const uniqueRows = Array.from(deduped.values());

    if (uniqueRows.length < rows.length) {
      warnings.push(`${rows.length - uniqueRows.length} linhas duplicadas removidas antes do upsert`);
    }

    // Upsert in batches of 200
    let upserted = 0;
    const batchSize = 200;
    for (let i = 0; i < uniqueRows.length; i += batchSize) {
      const batch = uniqueRows.slice(i, i + batchSize);
      const { error: upsertError } = await supabase
        .from("pd_lg_locations")
        .upsert(batch, { onConflict: "company_id,warehouse_code,location_id" });

      if (upsertError) {
        errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${upsertError.message}`);
      } else {
        upserted += batch.length;
      }
    }

    // ── Verification: sample records + cross-check with orders ──
    const sampleRecords: LgRow[] = uniqueRows.slice(0, 5);

    // Fetch orders that need LG resolution (paletizado or etiquetas_geradas)
    const { data: pendingOrders } = await supabase
      .from("orders")
      .select("id, order_number, lg_code, store_code, status")
      .in("status", ["paletizado", "etiquetas_geradas"]);

    const orderMatches: Array<{
      order_number: string;
      warehouse_code: string | null;
      location_id: string | null;
      matched: boolean;
      match_details?: string;
    }> = [];

    if (pendingOrders) {
      // Re-fetch all LG locations after upsert for accurate matching
      const { data: allLgs } = await supabase
        .from("pd_lg_locations")
        .select("location_id, warehouse_code, store_code, lg_number, city_label, customer_label")
        .eq("active", true);

      for (const order of pendingOrders) {
        if (!order.lg_code) {
          orderMatches.push({
            order_number: order.order_number,
            warehouse_code: order.store_code,
            location_id: null,
            matched: false,
            match_details: "LocationID (LG) não fornecido no EDI",
          });
          continue;
        }

        const lgNorm = `LG${String(order.lg_code).replace(/^LG/i, "")}`;
        const wh = order.store_code || "";
        const match = allLgs?.find(
          (loc) => loc.location_id === lgNorm && loc.warehouse_code === wh
        );

        orderMatches.push({
          order_number: order.order_number,
          warehouse_code: wh,
          location_id: lgNorm,
          matched: !!match,
          match_details: match
            ? `Loja ${match.store_code || "?"} · ${match.city_label || ""} · ${match.customer_label || ""}`
            : `Mapping em falta para warehouse_code=${wh} e location_id=${lgNorm}`,
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: errors.length === 0,
        upserted,
        total: rawRows.length,
        skipped: skippedNoLg,
        deduplicated: uniqueRows.length,
        duplicates_removed: rows.length - uniqueRows.length,
        errors,
        warnings,
        verification: {
          sample_records: sampleRecords,
          order_matches: orderMatches,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("import-lg-locations error:", error);
    return new Response(
      JSON.stringify({ success: false, error: `Erro interno: ${(error as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
