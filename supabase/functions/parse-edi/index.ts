// Using Deno.serve (native, no import needed)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { XMLParser } from "https://esm.sh/fast-xml-parser@4.3.4";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ParsedLine {
  line_number: number;
  article_code: string;
  article_description: string | null;
  quantity: number;
  unit: string;
  ean: string | null;
  article_id: string | null;
  quantity_cases: number | null;
  lg_code: string | null;
  store_code: string | null;
  warehouse_code: string | null;
  asn_number: string | null;
  asn_item_num: string | null;
}

interface ParsedOrder {
  order_number: string;
  customer_code: string | null;
  customer_name: string | null;
  delivery_site_code: string | null;
  delivery_site_name: string | null;
  delivery_date: string | null;
  order_date: string | null;
  warehouse_code: string | null;
  lines: ParsedLine[];
}

interface ParseDebug {
  warehouse_code_header: string | null;
  location_ids_found: string[];
  lines_without_location_id: number;
  line_location_ids: Array<{
    line_number: number;
    location_id: string | null;
    store_code: string | null;
  }>;
  lg_master_found: Array<{
    warehouse_code: string;
    location_id: string;
  }>;
  lg_master_missing: Array<{
    warehouse_code: string;
    location_id: string;
  }>;
  validation_warnings: string[];
}

interface ParseResult {
  success: boolean;
  orders: ParsedOrder[];
  errors: Array<{ line: number; message: string }>;
  warnings: Array<{ line: number; message: string }>;
  debug: ParseDebug;
}

function isXmlContent(content: string, filename: string): boolean {
  if (filename.toLowerCase().endsWith(".xml")) return true;
  const trimmed = content.trimStart();
  return trimmed.startsWith("<?xml") || trimmed.startsWith("<");
}

// Extract ALL DeliveryPlaceDetails from LineDeliveryInformation(s)
interface DeliveryPlaceInfo {
  locationId: string | null;
  internalCode: string | null;
  packageQtyBx: number | null;
  asnNumber: string | null;
  asnItemNum: string | null;
  asnSource?: string | null;
}

// Deep, case-insensitive ASN lookup. Searches the node and its nested objects
// (DeliveryPlaceDetail, DespatchAdvice, DespatchAdviceReference, ...).
function findAsn(node: unknown, depth = 0): { number: string | null; itemNum: string | null } {
  const out: { number: string | null; itemNum: string | null } = { number: null, itemNum: null };
  if (!node || typeof node !== "object" || depth > 4) return out;

  const clean = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "object") {
      const inner = (v as Record<string, unknown>)["#text"] ?? (v as Record<string, unknown>)["value"];
      return clean(inner);
    }
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  };

  const obj = node as Record<string, unknown>;
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = rawKey.toLowerCase().replace(/[^a-z]/g, "");
    const isItem = key.includes("asn") && (key.includes("item") || key.includes("line"));
    const isNumber = !isItem && (key === "asn" || (key.includes("asn") && (key.includes("number") || key.includes("num") || key.includes("id"))));

    if (isItem && !out.itemNum) out.itemNum = clean(value);
    else if (isNumber && !out.number) out.number = clean(value);

    if (value && typeof value === "object") {
      const isDespatch = key.includes("despatch") || key.includes("dispatch") || key.includes("shipment");
      const list = Array.isArray(value) ? value : [value];
      for (const child of list) {
        if (isDespatch) {
          const childObj = child as Record<string, unknown>;
          if (!out.number) out.number = clean(childObj?.["ID"] ?? childObj?.["Id"] ?? childObj?.["id"] ?? childObj?.["Number"]);
          if (!out.itemNum) out.itemNum = clean(childObj?.["LineNumber"] ?? childObj?.["lineNumber"] ?? childObj?.["ItemNum"]);
        }
        const nested = findAsn(child, depth + 1);
        if (!out.number) out.number = nested.number;
        if (!out.itemNum) out.itemNum = nested.itemNum;
      }
    }
  }

  return out;
}

// Same as findAsn but ignores DeliveryPlaceDetail / LineDeliveryInformation branches,
// so a parent-level lookup never borrows ASN from a sibling delivery place.
function findAsnShallow(node: unknown): { number: string | null; itemNum: string | null } {
  if (!node || typeof node !== "object") return { number: null, itemNum: null };
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (key.includes("deliveryplacedetail") || key.includes("linedeliveryinformation")) continue;
    copy[k] = v;
  }
  return findAsn(copy);
}

function extractAllDeliveryPlaceDetails(parent: Record<string, unknown>): DeliveryPlaceInfo[] {
  const ldNode = parent["LineDeliveryInformation"] || parent["lineDeliveryInformation"];
  const itemAsn = findAsnShallow(parent);
  if (!ldNode) return [];

  const results: DeliveryPlaceInfo[] = [];
  const ldList = Array.isArray(ldNode) ? ldNode : [ldNode];

  for (const ld of ldList) {
    if (!ld || typeof ld !== "object") continue;
    const ldObj = ld as Record<string, unknown>;

    // Extract ASN info from this LineDeliveryInformation (deep, case-insensitive)
    const ldAsn = findAsnShallow(ldObj);

    const dpdNode = ldObj["DeliveryPlaceDetail"] || ldObj["deliveryPlaceDetail"];
    if (!dpdNode) continue;

    const dpdList = Array.isArray(dpdNode) ? dpdNode : [dpdNode];
    for (const dpd of dpdList) {
      if (!dpd || typeof dpd !== "object") continue;
      const dpdObj = dpd as Record<string, unknown>;
      const locId = dig(dpdObj, ["LocationID", "locationID", "LocationId", "location_id"]);
      const intCode = dig(dpdObj, ["InternalCode", "internalCode", "internal_code", "Code", "code"]);
      const dpdAsn = findAsn(dpdObj);
      const asnNumber = dpdAsn.number ?? ldAsn.number ?? itemAsn.number;
      const asnItemNum = dpdAsn.itemNum ?? ldAsn.itemNum ?? itemAsn.itemNum;
      const asnSource = dpdAsn.number ? "DeliveryPlaceDetail" : ldAsn.number ? "LineDeliveryInformation" : itemAsn.number ? "ItemDetail" : null;

      let pkgQty: number | null = null;
      const pkgNode = dpdObj["Package"] || dpdObj["package"];
      if (pkgNode && typeof pkgNode === "object") {
        const pkgObj = pkgNode as Record<string, unknown>;
        const qVal = dig(pkgObj, ["Quantity", "quantity", "Value", "value"]);
        if (qVal) {
          const parsed = parseFloat(qVal.replace(",", "."));
          if (!isNaN(parsed)) pkgQty = parsed;
        }
      }

      // Also check for quantity at DeliveryPlaceDetail level
      const dpdQtyNode = dpdObj["Quantity"] || dpdObj["quantity"];
      let dpdQtyUnits: number | null = null;
      if (dpdQtyNode) {
        if (typeof dpdQtyNode === "object") {
          const qObj = dpdQtyNode as Record<string, unknown>;
          const val = parseFloat(String(dig(qObj, ["QuantityValue", "quantityValue", "Value", "value"]) || "0").replace(",", "."));
          if (!isNaN(val) && val > 0) dpdQtyUnits = val;
        } else {
          const val = parseFloat(String(dpdQtyNode).replace(",", "."));
          if (!isNaN(val) && val > 0) dpdQtyUnits = val;
        }
      }

      results.push({
        locationId: locId,
        internalCode: intCode,
        packageQtyBx: pkgQty || (dpdQtyUnits ? null : null),
        asnNumber: asnNumber,
        asnItemNum: asnItemNum,
        asnSource,
      });
    }
  }

  return results;
}

function normalizeLocationId(locationId: string | null): string | null {
  if (!locationId) return null;
  const cleaned = locationId.trim().toUpperCase();
  if (!cleaned) return null;
  if (/^LG\d+$/.test(cleaned)) return cleaned;
  if (/^\d+$/.test(cleaned)) return `LG${cleaned}`;
  return cleaned;
}

const DEFAULT_COMPANY_ID = "01";

function normalizeWarehouseCode(value: string | null | undefined): string {
  return (value || "").trim();
}

async function findLgByLookupKey(
  supabase: ReturnType<typeof createClient>,
  companyId: string,
  warehouseCode: string,
  locationId: string,
): Promise<{ location_id: string; warehouse_code: string | null; company_id: string; store_code: string | null; city_label: string | null; customer_label: string | null } | null> {
  const normalizedWarehouse = normalizeWarehouseCode(warehouseCode);
  const normalizedLocation = normalizeLocationId(locationId);

  if (!normalizedLocation) return null;

  // Strategy 1: Exact match (company + warehouse + location)
  if (normalizedWarehouse) {
    const { data } = await supabase
      .from("pd_lg_locations")
      .select("company_id, warehouse_code, location_id, store_code, city_label, customer_label")
      .eq("company_id", companyId)
      .eq("warehouse_code", normalizedWarehouse)
      .eq("location_id", normalizedLocation)
      .eq("active", true)
      .maybeSingle();

    if (data) return data;
  }

  // Strategy 2: Match by delivery_internal_code + location_id
  if (normalizedWarehouse) {
    const { data } = await supabase
      .from("pd_lg_locations")
      .select("company_id, warehouse_code, location_id, store_code, city_label, customer_label")
      .eq("company_id", companyId)
      .eq("delivery_internal_code", normalizedWarehouse)
      .eq("location_id", normalizedLocation)
      .eq("active", true)
      .maybeSingle();

    if (data) return data;
  }

  // Strategy 3: Fallback — match by location_id only (any warehouse)
  const { data } = await supabase
    .from("pd_lg_locations")
    .select("company_id, warehouse_code, location_id, store_code, city_label, customer_label")
    .eq("company_id", companyId)
    .eq("location_id", normalizedLocation)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  return data || null;
}

function parseXmlContent(content: string, result: ParseResult): ParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    isArray: (name: string) => ["ItemDetail", "OrderDetail", "LineDeliveryInformation", "LineItem", "DeliveryPlaceDetail"].includes(name),
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(content);
  } catch (e) {
    result.errors.push({ line: 0, message: `Erro ao interpretar XML: ${(e as Error).message}` });
    result.success = false;
    return result;
  }

  // Navigate to the root document node
  const root = parsed["Document"] || parsed["document"] || parsed["Order"] || parsed["order"] || Object.values(parsed).find(v => typeof v === "object" && v !== null);
  if (!root || typeof root !== "object") {
    result.errors.push({ line: 0, message: "Estrutura XML não reconhecida: nenhum nó raiz válido" });
    result.success = false;
    return result;
  }

  const doc = root as Record<string, unknown>;

  // --- OrderHeader ---
  const header = (doc["OrderHeader"] || doc["orderHeader"] || doc) as Record<string, unknown>;

  const orderNumber = dig(header, ["OrderNumber", "orderNumber", "order_number"]) || `ORD-${Date.now()}`;

  // BuyerInformation
  const buyerNode = header["BuyerInformation"] || header["buyerInformation"] || header;
  const buyerObj = (buyerNode && typeof buyerNode === "object") ? buyerNode as Record<string, unknown> : header;
  const customerName = dig(buyerObj, ["Name", "name", "CustomerName", "customer_name"]);
  const customerCode = dig(buyerObj, ["Code", "code", "CustomerCode", "customer_code"]);

  // DeliveryPlaceInformation (header-level warehouse)
  const dpNode = header["DeliveryPlaceInformation"] || header["deliveryPlaceInformation"] || header["DeliverySite"] || header["ShipTo"];
  const dpObj = (dpNode && typeof dpNode === "object") ? dpNode as Record<string, unknown> : null;
  const deliverySiteCode = dpObj ? dig(dpObj, ["InternalCode", "internalCode", "internal_code", "Code", "code"]) : null;
  const deliverySiteNameRaw = dpObj ? dig(dpObj, ["Name", "name", "Label", "label"]) : null;
  const deliverySiteName = deliverySiteNameRaw;

  // This is the warehouse_code from the header (Rule 0 source of truth)
  const headerWarehouseCode = deliverySiteCode;

  const deliveryDate =
    (dpObj ? dig(dpObj, [
      "RequestedDeliveryDate", "requestedDeliveryDate", "requested_delivery_date",
      "DeliveryDate", "deliveryDate", "delivery_date",
    ]) : null) ||
    dig(header, [
      "RequestedDeliveryDate", "requestedDeliveryDate", "requested_delivery_date",
      "DeliveryDate", "deliveryDate", "delivery_date",
      "ExpectedDeliveryDate", "ShipmentDate",
    ]) ||
    deepFindDate(header, ["requesteddeliverydate", "deliverydate", "expecteddeliverydate"]) ||
    deepFindDate(doc, ["requesteddeliverydate", "deliverydate", "expecteddeliverydate"]) ||
    deepFindDateLike(doc, ["deliverydate", "requesteddelivery"]);

  const orderDate =
    dig(header, [
      "OrderDate", "orderDate", "order_date",
      "DocumentDate", "documentDate", "document_date",
      "IssueDate", "issueDate", "Date", "date",
    ]) ||
    deepFindDate(header, ["orderdate", "documentdate", "issuedate"]) ||
    deepFindDate(doc, ["orderdate", "documentdate", "issuedate"]);

  // --- OrderDetail / ItemDetail / LineItem lines ---
  const detailNode = doc["OrderDetail"] || doc["orderDetail"] || doc["Items"] || doc["Lines"];

  // Intermediate: an item with its raw XML data
  interface RawItem {
    item: Record<string, unknown>;
  }
  const rawItems: RawItem[] = [];

  // Header debug
  result.debug.warehouse_code_header = headerWarehouseCode;

  // Helper: extract ALL line items from a container node
  function extractItemsFromContainer(container: Record<string, unknown>) {
    const itemTagNames = ["LineItem", "lineItem", "ItemDetail", "itemDetail", "Item", "item"];
    let foundItems = false;

    for (const tagName of itemTagNames) {
      const items = container[tagName];
      if (!items) continue;

      const itemArr = Array.isArray(items) ? items : [items];
      for (const it of itemArr) {
        if (!it || typeof it !== "object") continue;
        rawItems.push({ item: it as Record<string, unknown> });
      }
      foundItems = true;
    }
    return foundItems;
  }

  if (detailNode) {
    if (Array.isArray(detailNode)) {
      for (const d of detailNode) {
        if (!d || typeof d !== "object") continue;
        extractItemsFromContainer(d as Record<string, unknown>);
      }
    } else if (typeof detailNode === "object") {
      extractItemsFromContainer(detailNode as Record<string, unknown>);
    }
  }

  // Also check for LineItem / ItemDetail directly under doc root
  if (rawItems.length === 0) {
    extractItemsFromContainer(doc);
  }

  if (rawItems.length === 0) {
    result.errors.push({ line: 0, message: `Encomenda ${orderNumber}: nenhuma linha de produto encontrada` });
  }

  // ── EXPLODE: For each raw item, iterate ALL DeliveryPlaceDetails to create sub-lines ──
  const parsedLines: ParsedLine[] = [];
  const lineLocationIds = new Set<string>();
  let linesWithoutLocationId = 0;
  let globalLineNum = 0;

  for (let i = 0; i < rawItems.length; i++) {
    const { item } = rawItems[i];

    // EAN
    const ean = dig(item, ["StandardPartNumber", "standardPartNumber", "EAN", "ean", "Barcode", "barcode"]);
    if (!ean) {
      result.errors.push({ line: 0, message: `Encomenda ${orderNumber}, item ${i + 1}: EAN (StandardPartNumber) em falta` });
      continue;
    }

    const description = dig(item, ["Description", "description", "ItemDescription", "itemDescription", "Name", "name"]);

    // Número de linha ORIGINAL do XML (10, 20, 30...). Fallback: sequencial 10, 20, 30...
    const rawLineNum = dig(item, [
      "LineNumber", "lineNumber", "line_number",
      "LineItemNumber", "lineItemNumber",
      "ItemNumber", "itemNumber",
      "SequenceNumber", "sequenceNumber", "LineSequenceNumber",
      "PositionNumber", "Position",
    ]);
    const parsedLineNum = rawLineNum ? parseInt(String(rawLineNum).replace(/\D/g, ""), 10) : NaN;
    const xmlLineNum = Number.isFinite(parsedLineNum) && parsedLineNum > 0 ? parsedLineNum : (i + 1) * 10;

    // Parse item-level quantity (total for this item)
    const qtyNode = item["Quantity"] || item["quantity"];
    let itemQuantityUnits = 0;
    let itemQuantityCases = 0;

    if (qtyNode && typeof qtyNode === "object") {
      const qObj = qtyNode as Record<string, unknown>;
      const uom = dig(qObj, ["UOM", "uom", "Unit", "unit"]) || "";
      const val = parseFloat(String(dig(qObj, ["QuantityValue", "quantityValue", "Value", "value"]) || "0").replace(",", "."));
      if (uom.toUpperCase() === "UN" || uom.toUpperCase() === "EA" || uom === "") {
        itemQuantityUnits = isNaN(val) ? 0 : val;
      } else if (uom.toUpperCase() === "BX" || uom.toUpperCase() === "CX" || uom.toUpperCase() === "CS") {
        itemQuantityCases = isNaN(val) ? 0 : val;
      } else {
        itemQuantityUnits = isNaN(val) ? 0 : val;
      }
    } else {
      const val = parseFloat(String(qtyNode || "0").replace(",", "."));
      itemQuantityUnits = isNaN(val) ? 0 : val;
    }

    // Package quantity (cases) at item level
    const pkgNode = item["Package"] || item["package"];
    if (pkgNode && typeof pkgNode === "object") {
      const pObj = pkgNode as Record<string, unknown>;
      const pkgUom = dig(pObj, ["UOM", "uom", "Unit", "unit"]) || "";
      const pkgVal = parseFloat(String(dig(pObj, ["Quantity", "quantity", "Value", "value"]) || "0").replace(",", "."));
      if (pkgUom.toUpperCase() === "BX" || pkgUom.toUpperCase() === "CX" || pkgUom.toUpperCase() === "CS" || pkgUom === "") {
        if (!isNaN(pkgVal) && pkgVal > 0) itemQuantityCases = pkgVal;
      }
    }

    // Extract ALL delivery places for this item
    const deliveryPlaces = extractAllDeliveryPlaceDetails(item);

    if (deliveryPlaces.length === 0) {
      // No delivery info — create single line with header warehouse
      globalLineNum = xmlLineNum;
      linesWithoutLocationId++;

      result.debug.line_location_ids.push({ line_number: globalLineNum, location_id: null, store_code: null });

      parsedLines.push({
        line_number: globalLineNum,
        article_code: ean,
        article_description: description,
        quantity: itemQuantityUnits,
        unit: "UN",
        ean,
        article_id: null,
        quantity_cases: itemQuantityCases > 0 ? itemQuantityCases : null,
        lg_code: null,
        store_code: null,
        warehouse_code: headerWarehouseCode,
        asn_number: null,
        asn_item_num: null,
      });
    } else if (deliveryPlaces.length === 1) {
      // Single delivery — use full item quantity
      const dp = deliveryPlaces[0];
      const lgCode = normalizeLocationId(dp.locationId);
      globalLineNum = xmlLineNum;

      if (lgCode) lineLocationIds.add(lgCode);
      else linesWithoutLocationId++;

      result.debug.line_location_ids.push({ line_number: globalLineNum, location_id: lgCode, store_code: dp.internalCode });

      let qCases = itemQuantityCases > 0 ? itemQuantityCases : null;
      if (!qCases && dp.packageQtyBx && dp.packageQtyBx > 0) qCases = dp.packageQtyBx;

      parsedLines.push({
        line_number: globalLineNum,
        article_code: ean,
        article_description: description,
        quantity: itemQuantityUnits,
        unit: "UN",
        ean,
        article_id: null,
        quantity_cases: qCases,
        lg_code: lgCode,
        store_code: dp.internalCode,
        warehouse_code: headerWarehouseCode,
        asn_number: dp.asnNumber,
        asn_item_num: dp.asnItemNum,
      });
    } else {
      // MULTIPLE deliveries — explode into sub-lines
      // Each DeliveryPlaceDetail may have its own quantity via Package node
      // If quantities are provided per delivery, use them; otherwise split evenly
      let deliveryQuantitiesProvided = false;
      let totalDeliveryQty = 0;

      // Check if individual delivery quantities exist
      for (const dp of deliveryPlaces) {
        if (dp.packageQtyBx && dp.packageQtyBx > 0) {
          deliveryQuantitiesProvided = true;
          totalDeliveryQty += dp.packageQtyBx;
        }
      }

      // Re-read per-delivery quantities from the XML more carefully
      // Each DeliveryPlaceDetail might have its own Quantity element
      const ldNode = item["LineDeliveryInformation"] || item["lineDeliveryInformation"];
      const ldList = Array.isArray(ldNode) ? ldNode : [ldNode];
      
      interface DeliveryQty {
        locationId: string | null;
        internalCode: string | null;
        quantityUnits: number;
        quantityCases: number;
        asnNumber: string | null;
        asnItemNum: string | null;
      }
      
      const deliveryQtys: DeliveryQty[] = [];
      
      for (const ld of ldList) {
        if (!ld || typeof ld !== "object") continue;
        const ldObj = ld as Record<string, unknown>;
        
        const ldAsnQ = findAsnShallow(ldObj);
        const itemAsnQ = findAsnShallow(item as Record<string, unknown>);
        
        // Check for quantity at LineDeliveryInformation level
        let ldQtyUnits = 0;
        let ldQtyCases = 0;
        const ldQtyNode = ldObj["Quantity"] || ldObj["quantity"];
        if (ldQtyNode) {
          if (typeof ldQtyNode === "object") {
            const qObj = ldQtyNode as Record<string, unknown>;
            const uom = dig(qObj, ["UOM", "uom", "Unit", "unit"]) || "";
            const val = parseFloat(String(dig(qObj, ["QuantityValue", "quantityValue", "Value", "value"]) || "0").replace(",", "."));
            if (!isNaN(val) && val > 0) {
              if (uom.toUpperCase() === "BX" || uom.toUpperCase() === "CX" || uom.toUpperCase() === "CS") {
                ldQtyCases = val;
              } else {
                ldQtyUnits = val;
              }
            }
          } else {
            const val = parseFloat(String(ldQtyNode).replace(",", "."));
            if (!isNaN(val) && val > 0) ldQtyUnits = val;
          }
        }

        const dpdNode = ldObj["DeliveryPlaceDetail"] || ldObj["deliveryPlaceDetail"];
        if (!dpdNode) continue;
        const dpdList = Array.isArray(dpdNode) ? dpdNode : [dpdNode];

        for (const dpd of dpdList) {
          if (!dpd || typeof dpd !== "object") continue;
          const dpdObj = dpd as Record<string, unknown>;
          const locId = dig(dpdObj, ["LocationID", "locationID", "LocationId", "location_id"]);
          const intCode = dig(dpdObj, ["InternalCode", "internalCode", "internal_code", "Code", "code"]);
          const dpdAsnQ = findAsn(dpdObj);
          const asnNum = dpdAsnQ.number ?? ldAsnQ.number ?? itemAsnQ.number;
          const asnItemN = dpdAsnQ.itemNum ?? ldAsnQ.itemNum ?? itemAsnQ.itemNum;

          // Check for quantity at DeliveryPlaceDetail level
          let dpdQtyUnits = ldQtyUnits;
          let dpdQtyCases = ldQtyCases;
          const dpdQtyNode = dpdObj["Quantity"] || dpdObj["quantity"];
          if (dpdQtyNode) {
            if (typeof dpdQtyNode === "object") {
              const qObj = dpdQtyNode as Record<string, unknown>;
              const uom = dig(qObj, ["UOM", "uom", "Unit", "unit"]) || "";
              const val = parseFloat(String(dig(qObj, ["QuantityValue", "quantityValue", "Value", "value"]) || "0").replace(",", "."));
              if (!isNaN(val) && val > 0) {
                if (uom.toUpperCase() === "BX" || uom.toUpperCase() === "CX" || uom.toUpperCase() === "CS") {
                  dpdQtyCases = val;
                } else {
                  dpdQtyUnits = val;
                }
              }
            } else {
              const val = parseFloat(String(dpdQtyNode).replace(",", "."));
              if (!isNaN(val) && val > 0) dpdQtyUnits = val;
            }
          }

          // Package node at DPD level
          const dpdPkgNode = dpdObj["Package"] || dpdObj["package"];
          if (dpdPkgNode && typeof dpdPkgNode === "object") {
            const pkgObj = dpdPkgNode as Record<string, unknown>;
            const pkgVal = parseFloat(String(dig(pkgObj, ["Quantity", "quantity", "Value", "value"]) || "0").replace(",", "."));
            if (!isNaN(pkgVal) && pkgVal > 0 && dpdQtyCases === 0) {
              dpdQtyCases = pkgVal;
            }
          }

          deliveryQtys.push({
            locationId: locId,
            internalCode: intCode,
            quantityUnits: dpdQtyUnits,
            quantityCases: dpdQtyCases,
            asnNumber: asnNum,
            asnItemNum: asnItemN,
          });
        }
      }

      // If no per-delivery quantities found, split evenly
      const hasPerDeliveryQty = deliveryQtys.some(d => d.quantityUnits > 0 || d.quantityCases > 0);

      if (!hasPerDeliveryQty && itemQuantityUnits > 0) {
        // Split total quantity evenly across deliveries
        const perDelivery = Math.floor(itemQuantityUnits / deliveryQtys.length);
        const remainder = itemQuantityUnits - perDelivery * deliveryQtys.length;
        for (let j = 0; j < deliveryQtys.length; j++) {
          deliveryQtys[j].quantityUnits = perDelivery + (j < remainder ? 1 : 0);
        }
        result.warnings.push({
          line: 0,
          message: `Encomenda ${orderNumber}, EAN ${ean}: ${deliveryQtys.length} entregas sem quantidade individual — dividido equitativamente (${perDelivery} un cada)`,
        });
      }

      // Create sub-lines
      for (const dq of deliveryQtys) {
        const lgCode = normalizeLocationId(dq.locationId);
        globalLineNum = xmlLineNum;

        if (lgCode) lineLocationIds.add(lgCode);
        else linesWithoutLocationId++;

        result.debug.line_location_ids.push({ line_number: globalLineNum, location_id: lgCode, store_code: dq.internalCode });

        parsedLines.push({
          line_number: globalLineNum,
          article_code: ean,
          article_description: description,
          quantity: dq.quantityUnits,
          unit: "UN",
          ean,
          article_id: null,
          quantity_cases: dq.quantityCases > 0 ? dq.quantityCases : null,
          lg_code: lgCode,
          store_code: dq.internalCode,
          warehouse_code: headerWarehouseCode,
          asn_number: dq.asnNumber,
          asn_item_num: dq.asnItemNum,
        });
      }
    }
  }

  result.debug.location_ids_found = Array.from(lineLocationIds);
  result.debug.lines_without_location_id = linesWithoutLocationId;

  // Collect unique LG codes for the order-level summary
  const uniqueLgCodes = Array.from(new Set(parsedLines.map(l => l.lg_code).filter(Boolean)));

  const normalizedDeliveryDate = deliveryDate ? normalizeDate(deliveryDate) : null;
  const normalizedOrderDate = orderDate ? normalizeDate(orderDate) : null;


  result.orders.push({
    order_number: orderNumber,
    customer_code: customerCode,
    customer_name: customerName,
    delivery_site_code: deliverySiteCode,
    delivery_site_name: deliverySiteName,
    delivery_date: normalizedDeliveryDate,
    order_date: normalizedOrderDate,
    warehouse_code: headerWarehouseCode,
    lines: parsedLines,
  });

  result.success = result.errors.length === 0;
  return result;
}

// Dig into an object for the first matching key, returning string or null
function dig(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (key in obj && obj[key] != null) {
      const val = obj[key];
      if (typeof val === "object" && val !== null && "#text" in (val as Record<string, unknown>)) {
        return String((val as Record<string, unknown>)["#text"]);
      }
      if (typeof val === "object" && val !== null) continue;
      return String(val);
    }
  }
  return null;
}

function normalizeDate(dateStr: string): string | null {
  return normalizeDateImpl(dateStr);
}

// Recursive, case-insensitive search for a date-ish node by key name
// Recursive search matching any key whose name CONTAINS one of the fragments
function deepFindDateLike(node: unknown, fragments: string[], depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 8) return null;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const lk = k.toLowerCase().replace(/[^a-z]/g, "");
    if (fragments.some((f) => lk.includes(f))) {
      if (v == null) continue;
      if (typeof v === "object") {
        const t = (v as Record<string, unknown>)["#text"];
        if (t != null) return String(t);
      } else {
        return String(v);
      }
    }
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const found = deepFindDateLike(v, fragments, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function deepFindDate(node: unknown, keyNames: string[], depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const lk = k.toLowerCase().replace(/[^a-z]/g, "");
    if (keyNames.includes(lk)) {
      if (v == null) continue;
      if (typeof v === "object") {
        const t = (v as Record<string, unknown>)["#text"];
        if (t != null) return String(t);
      } else {
        return String(v);
      }
    }
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const found = deepFindDate(v, keyNames, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalizeDateImpl(dateStr: string): string | null {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.substring(0, 10);
  const clean = dateStr.replace(/[\/\-\.]/g, "");
  if (clean.length === 8) {
    if (parseInt(clean.substring(0, 4)) > 1900) {
      return `${clean.substring(0, 4)}-${clean.substring(4, 6)}-${clean.substring(6, 8)}`;
    }
    return `${clean.substring(4, 8)}-${clean.substring(2, 4)}-${clean.substring(0, 2)}`;
  }
  return null;
}

function parseEDIContent(content: string, filename: string): ParseResult {
  const result: ParseResult = {
    success: true,
    orders: [],
    errors: [],
    warnings: [],
    debug: {
      warehouse_code_header: null,
      location_ids_found: [],
      lines_without_location_id: 0,
      line_location_ids: [],
      lg_master_found: [],
      lg_master_missing: [],
      validation_warnings: [],
    },
  };

  if (isXmlContent(content, filename)) {
    return parseXmlContent(content, result);
  }

  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const isEdifact = normalizedContent.includes("UNH+") || normalizedContent.includes("'");

  if (isEdifact) {
    return parseEdifact(normalizedContent, result);
  } else {
    return parseFlatFile(normalizedContent, result);
  }
}

function parseEdifact(content: string, result: ParseResult): ParseResult {
  const segments = content.split("'").map(s => s.trim()).filter(s => s.length > 0);

  let currentOrder: ParsedOrder | null = null;
  let lineNumber = 0;
  let segmentLineMap: Map<number, number> = new Map();

  let charIndex = 0;
  let lineCount = 1;
  for (let i = 0; i < segments.length; i++) {
    segmentLineMap.set(i, lineCount);
    const segmentEnd = content.indexOf(segments[i], charIndex) + segments[i].length;
    lineCount += (content.substring(charIndex, segmentEnd).match(/\n/g) || []).length;
    charIndex = segmentEnd;
  }

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const approxLine = segmentLineMap.get(i) || i + 1;

    try {
      const elements = segment.split("+");
      const tag = elements[0];

      switch (tag) {
        case "UNH": {
          if (currentOrder) {
            result.orders.push(currentOrder);
          }
          currentOrder = {
            order_number: "",
            customer_code: null,
            customer_name: null,
            delivery_site_code: null,
            delivery_site_name: null,
            delivery_date: null,
            order_date: null,
            warehouse_code: null,
            lines: [],
          };
          lineNumber = 0;
          break;
        }

        case "BGM": {
          if (currentOrder && elements.length >= 3) {
            currentOrder.order_number = elements[2] || `ORD-${Date.now()}`;
          }
          break;
        }

        case "DTM": {
          if (currentOrder && elements.length >= 2) {
            const dtmParts = elements[1].split(":");
            if (dtmParts[0] === "137" || dtmParts[0] === "2") {
              const dateStr = dtmParts[1];
              if (dateStr && dateStr.length === 8) {
                currentOrder.delivery_date = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
              }
            }
          }
          break;
        }

        case "NAD": {
          if (currentOrder && elements.length >= 2) {
            const qualifier = elements[1];
            const partyId = elements[2]?.split(":")[0] || null;
            const partyName = elements[4]?.replace(/:/g, " ").trim() || null;

            if (qualifier === "BY" || qualifier === "BU") {
              currentOrder.customer_code = partyId;
              currentOrder.customer_name = partyName;
            } else if (qualifier === "DP" || qualifier === "ST") {
              currentOrder.delivery_site_code = partyId;
              currentOrder.delivery_site_name = partyName;
            }
          }
          break;
        }

        case "LIN": {
          if (currentOrder && elements.length >= 3) {
            lineNumber++;
            const itemCode = elements[3]?.split(":")[0] || elements[2] || "";

            if (!itemCode) {
              result.errors.push({ line: approxLine, message: `Linha ${lineNumber}: Código de artigo em falta no segmento LIN` });
              continue;
            }

            currentOrder.lines.push({
              line_number: lineNumber,
              article_code: itemCode,
              article_description: null,
              quantity: 0,
              unit: "UN",
              ean: null,
              article_id: null,
              quantity_cases: null,
              lg_code: null,
              store_code: null,
              warehouse_code: currentOrder.warehouse_code,
              asn_number: null,
              asn_item_num: null,
            });
          }
          break;
        }

        case "QTY": {
          if (currentOrder && currentOrder.lines.length > 0 && elements.length >= 2) {
            const qtyParts = elements[1].split(":");
            const qty = parseFloat(qtyParts[1] || "0");

            if (isNaN(qty) || qty <= 0) {
              result.warnings.push({ line: approxLine, message: `Linha ${lineNumber}: Quantidade inválida "${qtyParts[1]}", usando 0` });
            }

            const lastLine = currentOrder.lines[currentOrder.lines.length - 1];
            lastLine.quantity = isNaN(qty) ? 0 : qty;

            if (qtyParts.length > 2 && qtyParts[2]) {
              lastLine.unit = qtyParts[2];
            }
          }
          break;
        }

        case "IMD": {
          if (currentOrder && currentOrder.lines.length > 0 && elements.length >= 4) {
            const desc = elements[3]?.split(":").pop()?.replace(/\+/g, " ") || null;
            if (desc) {
              currentOrder.lines[currentOrder.lines.length - 1].article_description = desc;
            }
          }
          break;
        }

        case "PIA": {
          if (currentOrder && currentOrder.lines.length > 0 && elements.length >= 3) {
            const additionalCode = elements[2]?.split(":")[0];
            if (additionalCode && !currentOrder.lines[currentOrder.lines.length - 1].article_code) {
              currentOrder.lines[currentOrder.lines.length - 1].article_code = additionalCode;
            }
          }
          break;
        }

        case "UNT": {
          if (currentOrder) {
            if (!currentOrder.order_number) {
              result.errors.push({ line: approxLine, message: "Número de encomenda em falta (segmento BGM)" });
              currentOrder.order_number = `ORD-${Date.now()}`;
            }
            if (currentOrder.lines.length === 0) {
              result.errors.push({ line: approxLine, message: `Encomenda ${currentOrder.order_number} não contém linhas de produto` });
            }
            result.orders.push(currentOrder);
            currentOrder = null;
          }
          break;
        }
      }
    } catch (e) {
      result.errors.push({ line: approxLine, message: `Erro ao processar segmento: ${(e as Error).message}` });
    }
  }

  if (currentOrder) {
    if (currentOrder.lines.length > 0 || currentOrder.order_number) {
      result.orders.push(currentOrder);
    }
  }

  for (const order of result.orders) {
    for (const line of order.lines) {
      if (line.quantity === 0) {
        result.warnings.push({ line: 0, message: `Encomenda ${order.order_number}, Artigo ${line.article_code}: Quantidade é 0` });
      }
    }
  }

  result.success = result.errors.length === 0;
  return result;
}

function parseFlatFile(content: string, result: ParseResult): ParseResult {
  const lines = content.split("\n").filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    result.errors.push({ line: 1, message: "Ficheiro vazio" });
    result.success = false;
    return result;
  }

  const firstLine = lines[0];
  let delimiter = ";";
  if (firstLine.includes("\t")) delimiter = "\t";
  else if (firstLine.includes(",") && !firstLine.includes(";")) delimiter = ",";
  else if (firstLine.includes("|")) delimiter = "|";

  const hasHeader = firstLine.toLowerCase().includes("order") ||
                    firstLine.toLowerCase().includes("encomenda") ||
                    firstLine.toLowerCase().includes("artigo") ||
                    firstLine.toLowerCase().includes("cliente");

  const startLine = hasHeader ? 1 : 0;
  const ordersMap = new Map<string, ParsedOrder>();

  for (let i = startLine; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(delimiter).map(p => p.trim().replace(/^["']|["']$/g, ""));

    if (parts.length < 4) {
      result.errors.push({ line: lineNum, message: `Formato inválido: esperados pelo menos 4 campos, encontrados ${parts.length}` });
      continue;
    }

    const orderNumber = parts[0];
    if (!orderNumber) {
      result.errors.push({ line: lineNum, message: "Número de encomenda em falta" });
      continue;
    }

    const articleCode = parts[2] || parts[3];
    if (!articleCode) {
      result.errors.push({ line: lineNum, message: "Código de artigo em falta" });
      continue;
    }

    const qtyStr = parts[3] || parts[4] || "0";
    const quantity = parseFloat(qtyStr.replace(",", "."));
    if (isNaN(quantity)) {
      result.errors.push({ line: lineNum, message: `Quantidade inválida: "${qtyStr}"` });
      continue;
    }

    if (!ordersMap.has(orderNumber)) {
      ordersMap.set(orderNumber, {
        order_number: orderNumber,
        customer_code: parts[1] || null,
        customer_name: parts.length > 5 ? parts[5] : null,
        delivery_site_code: null,
        delivery_site_name: null,
        delivery_date: parts.length > 7 ? parseDate(parts[7]) : null,
        order_date: null,
        warehouse_code: null,
        lines: [],
      });
    }

    const order = ordersMap.get(orderNumber)!;
    order.lines.push({
      line_number: order.lines.length + 1,
      article_code: articleCode,
      article_description: parts.length > 4 ? parts[4] : null,
      quantity,
      unit: parts.length > 6 ? parts[6] || "UN" : "UN",
      ean: null,
      article_id: null,
      quantity_cases: null,
      lg_code: null,
      store_code: null,
      warehouse_code: null,
      asn_number: null,
      asn_item_num: null,
    });
  }

  result.orders = Array.from(ordersMap.values());
  result.success = result.errors.length === 0;

  if (result.orders.length === 0 && result.errors.length === 0) {
    result.errors.push({ line: 1, message: "Nenhuma encomenda válida encontrada no ficheiro" });
    result.success = false;
  }

  return result;
}

function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const cleanDate = dateStr.replace(/[\/\-\.]/g, "");
  if (cleanDate.length === 8) {
    if (parseInt(cleanDate.substring(0, 4)) > 1900) {
      return `${cleanDate.substring(0, 4)}-${cleanDate.substring(4, 6)}-${cleanDate.substring(6, 8)}`;
    } else {
      return `${cleanDate.substring(4, 8)}-${cleanDate.substring(2, 4)}-${cleanDate.substring(0, 2)}`;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const denied = await requireRole(req, supabase, ["admin", "operador"], corsHeaders);
    if (denied) return denied;

    const { storage_path, edi_file_id } = await req.json();

    if (!storage_path || !edi_file_id) {
      return new Response(
        JSON.stringify({ error: "storage_path e edi_file_id são obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Download file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("edi-files")
      .download(storage_path);

    if (downloadError) {
      return new Response(
        JSON.stringify({ error: `Erro ao ler ficheiro: ${downloadError.message}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Encoding fallback
    let content: string;
    try {
      content = await fileData.text();
      if (content.includes("\uFFFD")) {
        throw new Error("UTF-8 decode produced replacement characters");
      }
    } catch {
      const buffer = await fileData.arrayBuffer();
      const decoder = new TextDecoder("windows-1252");
      content = decoder.decode(buffer);
    }

    if (!content || content.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Ficheiro vazio" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parseResult = parseEDIContent(content, storage_path);

    if (!parseResult.success && parseResult.orders.length === 0) {
      await supabase
        .from("edi_files")
        .update({
          status: "error",
          error_message: parseResult.errors.map(e => e.message).join("; "),
          processed_at: new Date().toISOString()
        })
        .eq("id", edi_file_id);

      return new Response(
        JSON.stringify(parseResult),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Pre-fetch delivery sites
    const { data: deliverySites } = await supabase
      .from("delivery_sites")
      .select("id, internal_code, label_name, city")
      .eq("active", true);

    // Pre-fetch articles
    const { data: allArticles } = await supabase
      .from("articles")
      .select("id, code, ean, description, pieces_per_box")
      .eq("active", true);

    const articlesByEan = new Map<string, { id: string; code: string; description: string; pieces_per_box: number | null }>();
    const articlesByCode = new Map<string, { id: string; code: string; description: string; pieces_per_box: number | null }>();
    if (allArticles) {
      for (const a of allArticles) {
        const info = { id: a.id, code: a.code, description: a.description, pieces_per_box: a.pieces_per_box };
        if (a.ean) articlesByEan.set(a.ean, info);
        articlesByCode.set(a.code, info);
      }
    }

    // Create orders and lines in database
    const createdOrders = [];
    for (const order of parseResult.orders) {
      // Resolve delivery_site_id
      let deliverySiteId: string | null = null;
      let resolvedSiteName: string | null = null;
      let resolvedSiteCity: string | null = null;
      if (order.delivery_site_code && deliverySites) {
        const site = deliverySites.find(
          (s) => s.internal_code.toLowerCase() === order.delivery_site_code!.toLowerCase()
        );
        if (site) {
          deliverySiteId = site.id;
          resolvedSiteName = site.label_name;
          resolvedSiteCity = site.city;
        } else {
          const partialMatch = deliverySites.find(
            (s) => s.internal_code.toLowerCase().startsWith(order.delivery_site_code!.toLowerCase()) ||
                   order.delivery_site_code!.toLowerCase().startsWith(s.internal_code.toLowerCase())
          );
          if (partialMatch) {
            deliverySiteId = partialMatch.id;
            resolvedSiteName = partialMatch.label_name;
            resolvedSiteCity = partialMatch.city;
          } else {
            // Auto-create delivery site
            const rawName = order.delivery_site_name || "";
            let shortLabel = rawName;
            const dashMatch = rawName.match(/[-–]\s*(.+)/);
            if (dashMatch) {
              shortLabel = dashMatch[1].replace(/\s*(N\/P|C\/P|S\/P)\s*$/i, "").trim();
            }
            if (!shortLabel) shortLabel = rawName || order.delivery_site_code!;

            const { data: newSite, error: createSiteError } = await supabase
              .from("delivery_sites")
              .insert({
                internal_code: order.delivery_site_code!,
                label_name: shortLabel,
                city: shortLabel,
                customer_type: rawName.match(/^(PD|PINGO\s*DOCE)/i) ? "PINGO DOCE" : null,
              })
              .select("id, label_name, city")
              .single();

            if (!createSiteError && newSite) {
              deliverySiteId = newSite.id;
              resolvedSiteName = newSite.label_name;
              resolvedSiteCity = newSite.city;
              deliverySites.push({ id: newSite.id, internal_code: order.delivery_site_code!, label_name: newSite.label_name, city: newSite.city });
            } else {
              parseResult.warnings.push({ line: 0, message: `Não foi possível criar destino "${order.delivery_site_code}": ${createSiteError?.message}` });
            }
          }
        }
      }

      // Resolve article IDs and calculate missing quantity_cases
      let hasMissingPackSpecs = false;
      let hasPlaceholderArticles = false;
      for (const line of order.lines) {
        const ean = line.ean || line.article_code;
        const matchedByEan = articlesByEan.get(ean);
        const matchedByCode = articlesByCode.get(ean);
        const matched = matchedByEan || matchedByCode;

        if (matched) {
          line.article_id = matched.id;
          line.article_code = matched.code;
          if (!line.article_description) {
            line.article_description = matched.description;
          }

          // Calculate quantity_cases if not provided by XML
          if (!line.quantity_cases && line.quantity > 0) {
            if (matched.pieces_per_box && matched.pieces_per_box > 0) {
              line.quantity_cases = Math.ceil(line.quantity / matched.pieces_per_box);
            } else {
              hasMissingPackSpecs = true;
              parseResult.warnings.push({
                line: 0,
                message: `Artigo "${matched.code}" (EAN: ${ean}) sem unidades/caixa definidas — impossível calcular caixas`,
              });
            }
          }
        } else {
          // Create placeholder article
          hasPlaceholderArticles = true;
          const desc = line.article_description || `Artigo ${ean} (placeholder)`;
          const { data: newArticle, error: artErr } = await supabase
            .from("articles")
            .insert({
              code: ean,
              ean: ean,
              description: desc,
              pieces_per_box: 1,
              boxes_per_layer: 1,
              layers_per_pallet: 1,
              boxes_per_pallet: 1,
              active: true,
            })
            .select("id")
            .single();

          if (!artErr && newArticle) {
            line.article_id = newArticle.id;
            articlesByEan.set(ean, { id: newArticle.id, code: ean, description: desc, pieces_per_box: 1 });
            articlesByCode.set(ean, { id: newArticle.id, code: ean, description: desc, pieces_per_box: 1 });
            parseResult.warnings.push({ line: 0, message: `Artigo EAN "${ean}" criado como placeholder — importar dados mestre para completar` });
          } else {
            parseResult.warnings.push({ line: 0, message: `Artigo EAN "${ean}" não encontrado e não foi possível criar placeholder: ${artErr?.message}` });
          }
        }
      }

      // Validate ALL unique LGs against master data (GJMLGS) — QUERY ONLY, never correct order data
      const warehouseCodeLookup = normalizeWarehouseCode(
        order.warehouse_code || order.delivery_site_code || parseResult.debug.warehouse_code_header
      );

      const uniqueLineLgs = Array.from(new Set(
        order.lines.map(l => normalizeLocationId(l.lg_code)).filter(Boolean)
      )) as string[];

      for (const lgNorm of uniqueLineLgs) {
        const lgMatch = await findLgByLookupKey(supabase, DEFAULT_COMPANY_ID, warehouseCodeLookup, lgNorm);
        if (lgMatch) {
          if (!parseResult.debug.lg_master_found.some(i => i.location_id === lgNorm && i.warehouse_code === warehouseCodeLookup)) {
            parseResult.debug.lg_master_found.push({ location_id: lgNorm, warehouse_code: warehouseCodeLookup });
          }
        } else {
          if (!parseResult.debug.lg_master_missing.some(i => i.location_id === lgNorm && i.warehouse_code === warehouseCodeLookup)) {
            parseResult.debug.lg_master_missing.push({ location_id: lgNorm, warehouse_code: warehouseCodeLookup });
          }
          // WARNING only — never correct the order data
          parseResult.warnings.push({
            line: 0,
            message: `Combinação não cadastrada: Armazém=${warehouseCodeLookup || "(vazio)"} / LG=${lgNorm}. Verifique o cadastro GJMLGS — dados da encomenda mantidos intactos.`,
          });
          parseResult.debug.validation_warnings.push(
            `Armazém=${warehouseCodeLookup} / LG=${lgNorm}: não encontrado no cadastro GJMLGS`
          );
        }
      }

      // Validate unique store_codes from lines
      const uniqueStoreCodes = Array.from(new Set(
        order.lines.map(l => l.store_code).filter(Boolean)
      )) as string[];

      if (uniqueLineLgs.length === 0) {
        parseResult.warnings.push({ line: 0, message: `Encomenda ${order.order_number}: Nenhum LocationID (LG) encontrado nas linhas.` });
      }

      if (order.lines.length === 0) {
        parseResult.errors.push({ line: 0, message: `Encomenda ${order.order_number} não contém linhas válidas` });
        continue;
      }

      const { data: orderData, error: orderError } = await supabase
        .from("orders")
        .insert({
          edi_file_id,
          order_number: order.order_number,
          customer_code: order.customer_code,
          customer_name: order.customer_name || resolvedSiteName || order.delivery_site_name,
          delivery_date: order.delivery_date,
          order_date: order.order_date || null,
          delivery_site_id: deliverySiteId,
          store_code: order.warehouse_code || order.delivery_site_code,
          lg_code: null, // Multiple LGs — stored per line
          status: "importado",
          total_items: order.lines.reduce((sum, l) => sum + l.quantity, 0),
          notes: [
            order.delivery_site_code ? `Entrega: ${resolvedSiteName || order.delivery_site_name || ""} (${order.delivery_site_code})` : null,
            order.warehouse_code ? `Armazém: ${order.warehouse_code}` : null,
            uniqueLineLgs.length > 0 ? `LGs: ${uniqueLineLgs.join(", ")}` : null,
            uniqueStoreCodes.length > 0 ? `Lojas: ${uniqueStoreCodes.join(", ")}` : null,
            resolvedSiteCity ? `Cidade: ${resolvedSiteCity}` : null,
            hasMissingPackSpecs ? "⚠ Pendências: dados de embalagem em falta" : null,
            parseResult.debug.validation_warnings.length > 0 ? `⚠ ${parseResult.debug.validation_warnings.length} divergência(s) com GJMLGS` : null,
          ].filter(Boolean).join(" | ") || null,
        })
        .select()
        .single();

      if (orderError) {
        parseResult.errors.push({ line: 0, message: `Erro ao criar encomenda ${order.order_number}: ${orderError.message}` });
        continue;
      }

      // Create order lines with ALL new fields
      const linesToInsert = order.lines.map(line => ({
        order_id: orderData.id,
        line_number: line.line_number,
        article_code: line.article_code,
        article_description: line.article_description,
        article_id: line.article_id,
        quantity: line.quantity,
        unit: line.unit,
        lg_code: line.lg_code || null,
        store_code: line.store_code || null,
        warehouse_code: line.warehouse_code || null,
        quantity_cases: line.quantity_cases || null,
        asn_number: line.asn_number || null,
        asn_item_num: line.asn_item_num || null,
      }));

      const { error: linesError } = await supabase.from("order_lines").insert(linesToInsert);
      if (linesError) {
        parseResult.warnings.push({ line: 0, message: `Aviso: Algumas linhas de ${order.order_number} podem não ter sido criadas: ${linesError.message}` });
      }

      const linesWithoutAsn = order.lines.filter((l) => !l.asn_number).length;
      if (linesWithoutAsn > 0) {
        parseResult.warnings.push({
          line: 0,
          message: `${linesWithoutAsn} linha(s) da encomenda ${order.order_number} sem ASN Number. O DESADV não poderá ser gerado até que os ASN sejam introduzidos manualmente ou o XML seja reenviado com ASN.`,
        });
      }

      createdOrders.push({
        id: orderData.id,
        order_number: order.order_number,
        customer_name: order.customer_name,
        delivery_site_id: deliverySiteId,
        lines_count: order.lines.length,
        order_date: order.order_date || null,
        delivery_date: order.delivery_date || null,
      });
    }

    // Update EDI file status
    const hasValidationWarnings = parseResult.debug.validation_warnings.length > 0;
    await supabase
      .from("edi_files")
      .update({
        status: parseResult.errors.length > 0 ? "processed_with_errors" : (hasValidationWarnings ? "processed_with_warnings" : "processed"),
        processed_at: new Date().toISOString(),
        error_message: parseResult.errors.length > 0
          ? parseResult.errors.map(e => e.message).join("; ").substring(0, 500)
          : null
      })
      .eq("id", edi_file_id);

    return new Response(
      JSON.stringify({
        ...parseResult,
        created_orders: createdOrders,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Parse EDI error:", error);
    return new Response(
      JSON.stringify({ error: `Erro interno: ${(error as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
