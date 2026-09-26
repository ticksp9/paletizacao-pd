import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import * as XLSX from "npm:xlsx@0.18.5/xlsx.mjs";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ParsedRow {
  rowNum: number;
  ean: string;
  internal_code: string | null;
  description: string;
  pieces_per_box: number;
  weight_kg: number | null;
  dimensions_mm: string | null;
  boxes_per_layer: number | null;
  layers_per_pallet: number | null;
}

interface ImportReport {
  created: number;
  updated: number;
  errors: { row: number; ean: string; message: string }[];
  warnings: { row: number; ean: string; message: string }[];
  total_rows: number;
}

function normaliseHeader(h: string): string {
  return h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function findCol(headers: string[], patterns: string[]): number {
  return headers.findIndex((h) => patterns.some((p) => h.includes(p)));
}

function parseWeightKg(raw: string | undefined): { value: number | null; valid: boolean } {
  const value = raw?.trim() || "";
  if (!value) return { value: null, valid: true };
  if (!/^\d+(?:[.,]\d+)?$/.test(value)) return { value: null, valid: false };
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return { value: null, valid: false };
  return { value: parsed, valid: true };
}

function parseDimensionsToMm(raw: string): { value: string; ok: boolean } {
  if (!raw || !raw.trim()) return { value: "", ok: false };
  const match = raw.trim().match(
    /^(\d+(?:[.,]\d+)?)\s*[xX×*]\s*(\d+(?:[.,]\d+)?)\s*[xX×*]\s*(\d+(?:[.,]\d+)?)$/
  );
  if (!match) return { value: "", ok: false };
  const nums = [match[1], match[2], match[3]].map((n) =>
    Math.round(parseFloat(n.replace(",", ".")) * 10)
  );
  return { value: `${nums[0]}x${nums[1]}x${nums[2]}`, ok: true };
}

function parseCSV(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; }
      else if ((char === "," || char === ";" || char === "\t") && !inQuotes) { result.push(current.trim()); current = ""; }
      else { current += char; }
    }
    result.push(current.trim());
    return result;
  });
}

function onlyDigits(value: string | null | undefined): string {
  return String(value || "").replace(/\D/g, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);
    const authResponse = await requireRole(req, adminClient, "admin", corsHeaders);
    if (authResponse) return authResponse;

    const body = await req.json();
    const { file_path, file_name } = body;

    if (!file_path || !file_name) {
      return new Response(JSON.stringify({ error: "file_path e file_name são obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: fileData, error: downloadError } = await adminClient.storage
      .from("masterdata")
      .download(file_path);

    if (downloadError || !fileData) {
      return new Response(JSON.stringify({ error: `Erro ao ler ficheiro: ${downloadError?.message || "não encontrado"}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const lowerName = file_name.toLowerCase();
    let rawRows: string[][] = [];

    if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
      const buffer = await fileData.arrayBuffer();
      const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
      rawRows = jsonData.map((row) => row.map(String));
    } else {
      let text: string;
      try {
        text = await fileData.text();
        if (text.includes("\uFFFD")) throw new Error("bad utf8");
      } catch {
        const buf = await fileData.arrayBuffer();
        text = new TextDecoder("windows-1252").decode(buf);
      }
      rawRows = parseCSV(text);
    }

    if (rawRows.length < 2) {
      return new Response(JSON.stringify({ error: "Ficheiro vazio ou sem dados" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Find header row
    const headerKeywords = ["ean", "codigo", "code", "descri", "designa", "nome", "pea", "peca", "piece", "medida", "dimenso", "ref", "artigo", "barcode", "gtin", "caselen", "comprimento", "largura", "altura", "weight", "peso", "unidade", "preco", "price", "camada", "layer", "palete", "pallet", "cxcam", "cxpal"];
    let headerRowIdx = -1;
    for (let r = 0; r < Math.min(rawRows.length, 15); r++) {
      const normRow = rawRows[r].map(normaliseHeader);
      const matchCount = normRow.filter((h) => h && headerKeywords.some((k) => h.includes(k))).length;
      if (matchCount >= 1) {
        headerRowIdx = r;
        break;
      }
    }

    if (headerRowIdx === -1) {
      for (let r = 0; r < Math.min(rawRows.length, 15); r++) {
        const nonEmpty = rawRows[r].filter((c) => c && c.trim().length > 0);
        if (nonEmpty.length >= 3 && nonEmpty.every((c) => c.length < 50 && !/^\d+([.,]\d+)?$/.test(c.trim()))) {
          headerRowIdx = r;
          break;
        }
      }
    }

    if (headerRowIdx === -1) headerRowIdx = 0;

    const headers = rawRows[headerRowIdx].map(normaliseHeader);
    const dataStartIdx = headerRowIdx + 1;

    console.log("Header row index:", headerRowIdx);
    console.log("Detected headers (normalised):", headers);
    console.log("Raw headers:", rawRows[headerRowIdx]);

    // Column detection
    const eanIdx = findCol(headers, ["ean", "codigobarras", "barcode", "codbarras", "cod_barras", "codbarra", "gtin", "ean13", "ean8"]);
    const pdCodeIdx = findCol(headers, ["codpingodoce", "codigopingodoce", "codpd", "codigopd", "codartigo", "codigoartigo", "codart", "internalcode"]);
    let finalEanIdx = eanIdx;
    if (finalEanIdx === -1) {
      const codeIdx = findCol(headers, ["codigo", "code", "ref", "referencia", "artigo", "codart", "codigoartigo", "itemcode"]);
      if (codeIdx !== -1) finalEanIdx = codeIdx;
    }

    // Content-based fallback for EAN column
    if (finalEanIdx === -1 && rawRows.length > dataStartIdx) {
      for (let col = 0; col < rawRows[dataStartIdx].length; col++) {
        let digitCount = 0;
        const sampleSize = Math.min(5, rawRows.length - dataStartIdx);
        for (let r = dataStartIdx; r < dataStartIdx + sampleSize; r++) {
          const val = (rawRows[r][col] || "").trim();
          if (/^\d{4,14}$/.test(val)) digitCount++;
        }
        if (digitCount >= Math.ceil(sampleSize * 0.6)) {
          finalEanIdx = col;
          console.log(`EAN column detected by content analysis at index ${col}`);
          break;
        }
      }
    }

    const descIdx = findCol(headers, ["descri", "designa", "nome", "name", "description"]);
    const piecesIdx = findCol(headers, ["pea", "peca", "piece", "pecascx", "unidadescx", "pcx", "piecespercase", "uncx", "unicx", "qtdcx"]);
    const dimIdx = findCol(headers, ["medida", "dimenso", "dimension", "caixa", "casedims"]);
    const lenIdx = findCol(headers, ["caselen", "comprimento", "length"]);
    const widIdx = findCol(headers, ["casewid", "largura", "width"]);
    const heiIdx = findCol(headers, ["casehei", "altura", "height"]);
    const hasIndividualDims = lenIdx !== -1 && widIdx !== -1 && heiIdx !== -1;
    const weightIdx = findCol(headers, ["pesocaixakg", "weight", "peso"]);

    // NEW: boxes_per_layer, layers_per_pallet, total boxes_per_pallet
    const bplIdx = findCol(headers, ["cxcamada", "caixascamada", "boxeslayer", "boxesperlayer", "cxcam", "boxlayer"]);
    const lppIdx = findCol(headers, ["camadaspalete", "camadaspal", "layerspallet", "layersperpallet", "campal", "layerpal"]);
    const totalBppIdx = findCol(headers, ["cxpalete", "caixaspalete", "boxespallet", "boxesperpallet", "totalcxpal", "totalboxpal"]);

    console.log("Column indices — EAN:", finalEanIdx, "Desc:", descIdx, "Pieces:", piecesIdx, "Dim:", dimIdx, "BPL:", bplIdx, "LPP:", lppIdx, "TotalBPP:", totalBppIdx);

    if (finalEanIdx === -1) {
      return new Response(JSON.stringify({ error: `Coluna EAN/Código não encontrada no cabeçalho. Colunas detectadas: ${rawRows[headerRowIdx].join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const report: ImportReport = { created: 0, updated: 0, errors: [], warnings: [], total_rows: rawRows.length - dataStartIdx };
    const validRows: ParsedRow[] = [];

    for (let i = dataStartIdx; i < rawRows.length; i++) {
      const row = rawRows[i];
      const ean = row[finalEanIdx]?.trim();
      if (!ean) continue; // skip empty rows silently

      const rawWeight = weightIdx === -1 ? "" : row[weightIdx];
      const weight = parseWeightKg(rawWeight);
      if (!weight.valid) {
        report.errors.push({
          row: i + 1,
          ean,
          message: `Peso caixa (kg) inválido "${rawWeight?.trim() || ""}" — indique um número não negativo, com vírgula ou ponto decimal.`,
        });
        continue;
      }

      // Description (optional - default to EAN)
      const description = descIdx !== -1 ? row[descIdx]?.trim() || "" : "";

      // Pieces per box (required if column exists, default 1 if column missing)
      let pieces = 1;
      if (piecesIdx !== -1) {
        const piecesRaw = row[piecesIdx]?.trim() || "";
        const parsed = parseInt(piecesRaw);
        if (parsed && parsed >= 1) {
          pieces = parsed;
        } else if (piecesRaw) {
          report.warnings.push({ row: i + 1, ean, message: `Peças/Cx. inválido "${piecesRaw}" — usando 1` });
        }
      }

      // Dimensions
      let dimensionsMm: string | null = null;
      if (hasIndividualDims) {
        const l = parseFloat((row[lenIdx] || "").replace(",", "."));
        const w = parseFloat((row[widIdx] || "").replace(",", "."));
        const h = parseFloat((row[heiIdx] || "").replace(",", "."));
        if (!isNaN(l) && !isNaN(w) && !isNaN(h) && l > 0 && w > 0 && h > 0) {
          dimensionsMm = `${Math.round(l * 10)}x${Math.round(w * 10)}x${Math.round(h * 10)}`;
        }
      } else if (dimIdx !== -1) {
        const dimRaw = row[dimIdx]?.trim() || "";
        if (dimRaw) {
          const dims = parseDimensionsToMm(dimRaw);
          if (dims.ok) dimensionsMm = dims.value;
        }
      }

      // Boxes per layer / layers per pallet
      let boxesPerLayer: number | null = null;
      let layersPerPallet: number | null = null;

      if (bplIdx !== -1) {
        const v = parseInt((row[bplIdx] || "").trim());
        if (v && v >= 1) boxesPerLayer = v;
      }
      if (lppIdx !== -1) {
        const v = parseInt((row[lppIdx] || "").trim());
        if (v && v >= 1) layersPerPallet = v;
      }

      // If we have total cx/pal but not individual columns, try to derive
      if (totalBppIdx !== -1 && (!boxesPerLayer || !layersPerPallet)) {
        const totalBpp = parseInt((row[totalBppIdx] || "").trim());
        if (totalBpp && totalBpp >= 1) {
          if (boxesPerLayer && !layersPerPallet) {
            layersPerPallet = Math.round(totalBpp / boxesPerLayer);
          } else if (!boxesPerLayer && layersPerPallet) {
            boxesPerLayer = Math.round(totalBpp / layersPerPallet);
          }
          // If neither, just store total as boxes_per_layer=total, layers=1
          if (!boxesPerLayer && !layersPerPallet) {
            boxesPerLayer = totalBpp;
            layersPerPallet = 1;
          }
        }
      }

      validRows.push({
        rowNum: i + 1,
        ean,
        internal_code: pdCodeIdx !== -1 ? onlyDigits(row[pdCodeIdx]) || null : null,
        description: description || ean,
        pieces_per_box: pieces,
        weight_kg: weight.value,
        dimensions_mm: dimensionsMm,
        boxes_per_layer: boxesPerLayer,
        layers_per_pallet: layersPerPallet,
      });
    }

    // Upsert in DB
    const allEans = validRows.map((r) => r.ean);
    const { data: existingArticles } = await adminClient.from("articles").select("id, ean, code").in("ean", allEans);
    const existingByEan = new Map<string, string>();
    if (existingArticles) {
      for (const a of existingArticles) { if (a.ean) existingByEan.set(a.ean, a.id); }
    }
    // Also check by code for articles created as placeholders (code = EAN, ean = null)
    const { data: existingByCode } = await adminClient.from("articles").select("id, code").in("code", allEans);
    const codeMap = new Map<string, string>();
    if (existingByCode) {
      for (const a of existingByCode) { codeMap.set(a.code, a.id); }
    }

    for (const row of validRows) {
      const existingId = existingByEan.get(row.ean) || codeMap.get(row.ean);
      const bpl = row.boxes_per_layer || 1;
      const lpp = row.layers_per_pallet || 1;

      const articleData: Record<string, unknown> = {
        description: row.description,
        pieces_per_box: row.pieces_per_box,
        dimensions_cm: row.dimensions_mm,
        ean: row.ean,
        code: row.ean,
        boxes_per_layer: bpl,
        layers_per_pallet: lpp,
        boxes_per_pallet: bpl * lpp,
      };

      if (existingId) {
        // A missing or blank optional weight means preserve the existing value.
        // Keep it out of the update payload rather than writing null.
        if (row.weight_kg !== null) articleData.weight_kg = row.weight_kg;
        const { error } = await adminClient.from("articles").update(articleData).eq("id", existingId);
        if (error) { report.errors.push({ row: row.rowNum, ean: row.ean, message: error.message }); }
        else { report.updated++; }
      } else {
        const { error } = await adminClient.from("articles").insert({
          ...articleData,
          weight_kg: row.weight_kg,
          active: true,
        });
        if (error) { report.errors.push({ row: row.rowNum, ean: row.ean, message: error.message }); }
        else { report.created++; }
      }

      if (row.internal_code) {
        const { error } = await adminClient
          .from("pd_internal_article_codes")
          .upsert({
            ean: row.ean,
            internal_code: row.internal_code,
            description: row.description,
            source_filename: file_name,
            active: true,
          }, { onConflict: "ean" });
        if (error) {
          report.errors.push({ row: row.rowNum, ean: row.ean, message: `Código Pingo Doce não importado: ${error.message}` });
        }
      }
    }

    return new Response(JSON.stringify(report), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("import_masterdata_items error:", err);
    const message = err instanceof Error ? err.message : "Erro interno";
    return new Response(JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
