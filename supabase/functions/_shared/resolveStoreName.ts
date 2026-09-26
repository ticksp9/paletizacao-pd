// Shared masterdata enrichment for label generation (PDF + ZPL).
// Golden rule: warehouse_code / store_code / lg_code ALWAYS come from the order.
// pd_lg_locations is query-only, used to enrich printed TEXT.
// Never guess a store by LG alone.

export interface StoreResolution {
  store_name: string;
  store_city: string;
  warning: string | null;
  attempt: 1 | 2 | 3;
}

export function cleanStoreName(raw: string): string {
  let cleaned = raw.replace(/^\d+\s*-\s*/, "").trim();
  cleaned = cleaned.replace(/^PD-/i, "PD ").trim();
  return cleaned;
}

export function formatStoreLabelName(name: string, storeCode: string): string {
  const storeName = name
    .trim()
    .replace(/^(?:PD\s*[-–]?\s*)+/i, "")
    .trim() || `LOJA ${storeCode}`;
  return `PD ${storeName}`.toUpperCase();
}

export function formatStoreLabelCity(city: string, line1: string): string {
  const storeCity = city.trim();
  const storeName = line1.replace(/^PD\s+/i, "").trim();
  return storeCity && storeCity.toUpperCase() !== storeName.toUpperCase()
    ? storeCity
    : "";
}

export function extractNames(data: Record<string, unknown>): { store_name: string; store_city: string } {
  const rawName = String(data.name || data.customer_label || data.supermarket_name || "").trim();
  const storeName = cleanStoreName(rawName);
  const rawCity = String(data.city_label || "").trim();
  return { store_name: storeName, store_city: rawCity };
}

const FIELDS = "location_id, customer_label, city_label, supermarket_name, name, updated_at";

// deno-lint-ignore no-explicit-any
type Client = any;

export async function resolveStoreName(
  supabase: Client,
  warehouseCode: string,
  storeCode: string,
  lgCode: string,
  cache: Map<string, StoreResolution>,
  ctx?: { order_id?: string; pallet_number?: number },
): Promise<StoreResolution> {
  const cacheKey = `${warehouseCode}|${storeCode}|${lgCode}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const lgNormalized = `LG${String(lgCode || "").replace(/^LG/i, "").trim()}`;
  let result: StoreResolution | null = null;

  // Attempt 1: exact match (warehouse + store + LG)
  if (warehouseCode && storeCode) {
    const { data } = await supabase
      .from("pd_lg_locations").select(FIELDS)
      .eq("company_id", "01")
      .eq("warehouse_code", warehouseCode)
      .eq("store_code", storeCode)
      .eq("location_id", lgNormalized)
      .eq("active", true)
      .limit(1).maybeSingle();
    if (data) {
      const names = extractNames(data);
      result = { ...names, warning: null, attempt: 1 };
    }
  }

  // Attempt 2: same warehouse + same store, different LG
  if (!result && warehouseCode && storeCode) {
    const { data } = await supabase
      .from("pd_lg_locations").select(FIELDS)
      .eq("company_id", "01")
      .eq("warehouse_code", warehouseCode)
      .eq("store_code", storeCode)
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(20);
    const rows = (data || []) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      const target = parseInt(lgNormalized.replace(/^LG/i, ""), 10);
      const best = rows.slice().sort((a, b) => {
        const an = Math.abs((parseInt(String(a.location_id || "").replace(/^LG/i, ""), 10) || 0) - (target || 0));
        const bn = Math.abs((parseInt(String(b.location_id || "").replace(/^LG/i, ""), 10) || 0) - (target || 0));
        return an - bn;
      })[0];
      const names = extractNames(best);
      result = {
        ...names,
        warning:
          `Loja ${storeCode} encontrada mas com LG diferente (${String(best.location_id || "")} vs ${lgNormalized}). A usar nome da loja; verificar masterdata.`,
        attempt: 2,
      };
    }
  }

  // Attempt 3: neutral fallback — never another store's name
  if (!result) {
    result = {
      store_name: `LOJA ${storeCode}`,
      store_city: "",
      warning:
        `Combinação não registada: Armazém ${warehouseCode} / Loja ${storeCode} / LG ${lgNormalized}. Registar em Dados Mestre → LG / Lojas PD.`,
      attempt: 3,
    };
  }

  if (result.attempt !== 1) {
    console.warn(
      `[labels] store name fallback attempt=${result.attempt} order_id=${ctx?.order_id ?? "-"} pallet=${ctx?.pallet_number ?? "-"} warehouse=${warehouseCode} store=${storeCode} lg=${lgNormalized} resolved="${result.store_name}"`,
    );
  }

  cache.set(cacheKey, result);
  return result;
}
