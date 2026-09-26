import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import * as XLSX from "npm:xlsx@0.18.5/xlsx.mjs";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ImportReport {
  created: number;
  updated: number;
  errors: { row: number; ean: string; message: string }[];
  warnings: { row: number; ean: string; message: string }[];
  total_rows: number;
}

function normaliseHeader(h: string): string {
  return String(h || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function findCol(headers: string[], patterns: string[]): number {
  return headers.findIndex((h) => patterns.some((p) => h.includes(p)));
}

function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function parseCSV(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const delim = lines[0]?.includes(";") ? ";" : lines[0]?.includes("\t") ? "\t" : ",";
  return lines.map((line) => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === delim && !inQuotes) { result.push(current.trim()); current = ""; }
      else current += char;
    }
    result.push(current.trim());
    return result;
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);
    const authResponse = await requireRole(req, adminClient, "admin", corsHeaders);
    if (authResponse) return authResponse;

    const { file_path, file_name, replace_all } = await req.json();
    if (!file_path || !file_name) {
      return new Response(JSON.stringify({ error: "file_path e file_name são obrigatórios" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: fileData, error: dlErr } = await adminClient.storage.from("masterdata").download(file_path);
    if (dlErr || !fileData) {
      return new Response(JSON.stringify({ error: `Erro ao ler ficheiro: ${dlErr?.message || "não encontrado"}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const lower = file_name.toLowerCase();
    let rawRows: string[][] = [];
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      const buffer = await fileData.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
      rawRows = json.map((row) => row.map((c) => String(c ?? "")));
    } else {
      let text: string;
      try {
        text = await fileData.text();
        if (text.includes("\uFFFD")) throw new Error("bad utf8");
      } catch {
        text = new TextDecoder("windows-1252").decode(await fileData.arrayBuffer());
      }
      rawRows = parseCSV(text);
    }

    if (rawRows.length < 2) {
      return new Response(JSON.stringify({ error: "Ficheiro vazio ou sem dados" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Find header row
    const keywords = ["pingo", "doce", "codpd", "codigo", "code", "ean", "barcode", "designa", "descri", "nome"];
    let headerIdx = -1;
    for (let r = 0; r < Math.min(rawRows.length, 15); r++) {
      const norm = rawRows[r].map(normaliseHeader);
      const matches = norm.filter((h) => h && keywords.some((k) => h.includes(k))).length;
      if (matches >= 2) { headerIdx = r; break; }
    }
    if (headerIdx === -1) headerIdx = 0;

    const headers = rawRows[headerIdx].map(normaliseHeader);
    const dataStart = headerIdx + 1;

    const pdIdx = findCol(headers, ["codpingodoce", "codigopingodoce", "pingodoce", "codpd", "codigopd", "internalcode"]);
    const eanIdx = findCol(headers, ["ean", "barcode", "gtin", "codbarras", "codigobarras"]);
    const descIdx = findCol(headers, ["designa", "descri", "nome", "name", "description"]);

    if (pdIdx === -1 || eanIdx === -1) {
      return new Response(JSON.stringify({ error: `Colunas obrigatórias em falta. Esperado: Cód. Pingo Doce + EAN. Detectado: ${rawRows[headerIdx].join(", ")}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const report: ImportReport = { created: 0, updated: 0, errors: [], warnings: [], total_rows: rawRows.length - dataStart };

    if (replace_all === true) {
      await adminClient.from("pd_internal_article_codes").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }

    for (let i = dataStart; i < rawRows.length; i++) {
      const row = rawRows[i];
      const ean = onlyDigits(row[eanIdx]);
      const internal = onlyDigits(row[pdIdx]);
      const description = descIdx !== -1 ? String(row[descIdx] || "").trim() : "";

      if (!ean) continue;
      if (!/^[0-9]{4,14}$/.test(ean)) {
        report.errors.push({ row: i + 1, ean, message: `EAN inválido` });
        continue;
      }
      if (!internal) {
        report.errors.push({ row: i + 1, ean, message: `Cód. Pingo Doce vazio` });
        continue;
      }

      const { data: existing } = await adminClient.from("pd_internal_article_codes").select("id").eq("ean", ean).maybeSingle();
      const payload = { ean, internal_code: internal, description: description || null, source_filename: file_name, active: true };
      if (existing) {
        const { error } = await adminClient.from("pd_internal_article_codes").update(payload).eq("id", existing.id);
        if (error) report.errors.push({ row: i + 1, ean, message: error.message });
        else report.updated++;
      } else {
        const { error } = await adminClient.from("pd_internal_article_codes").insert(payload);
        if (error) report.errors.push({ row: i + 1, ean, message: error.message });
        else report.created++;
      }
    }

    return new Response(JSON.stringify(report), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("import-pd-article-codes error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Erro interno" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});