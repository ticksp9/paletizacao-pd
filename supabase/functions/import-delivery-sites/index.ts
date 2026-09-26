import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function findCol(headers: string[], aliases: string[]): number {
  return headers.findIndex((h) => aliases.some((a) => h.includes(a)));
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

    const { file_path, file_name } = await req.json();
    if (!file_path) {
      return new Response(JSON.stringify({ error: "file_path obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Download file
    const { data: fileData, error: dlErr } = await supabase.storage
      .from("masterdata")
      .download(file_path);

    if (dlErr || !fileData) {
      return new Response(JSON.stringify({ error: `Erro ao ler ficheiro: ${dlErr?.message}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let content: string;
    try {
      content = await fileData.text();
      if (content.includes("\uFFFD")) throw new Error("bad utf8");
    } catch {
      const buffer = await fileData.arrayBuffer();
      content = new TextDecoder("windows-1252").decode(buffer);
    }

    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return new Response(JSON.stringify({ error: "Ficheiro vazio" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Detect delimiter
    let delimiter = ";";
    if (lines[0].includes("\t")) delimiter = "\t";
    else if (lines[0].includes(",") && !lines[0].includes(";")) delimiter = ",";

    // Parse into rows
    const rawRows = lines.map((l) => l.split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, "")));

    // Find header row
    const headerKeywords = ["codigo", "code", "interno", "internal", "nome", "label", "cidade", "city", "cliente", "customer", "morada", "address", "postal"];
    let headerRowIdx = -1;
    for (let r = 0; r < Math.min(rawRows.length, 10); r++) {
      const normRow = rawRows[r].map(normaliseHeader);
      const matchCount = normRow.filter((h) => h && headerKeywords.some((k) => h.includes(k))).length;
      if (matchCount >= 1) {
        headerRowIdx = r;
        break;
      }
    }

    // Fallback: first row with multiple short non-numeric cells
    if (headerRowIdx === -1) {
      for (let r = 0; r < Math.min(rawRows.length, 10); r++) {
        const nonEmpty = rawRows[r].filter((c) => c && c.length > 0);
        if (nonEmpty.length >= 2 && nonEmpty.every((c) => c.length < 50 && !/^\d+([.,]\d+)?$/.test(c.trim()))) {
          headerRowIdx = r;
          break;
        }
      }
    }
    if (headerRowIdx === -1) headerRowIdx = 0;

    const headers = rawRows[headerRowIdx].map(normaliseHeader);
    const dataStartIdx = headerRowIdx + 1;

    console.log("Headers detected:", headers);

    // Find columns
    let codeIdx = findCol(headers, ["codigointerno", "codigo", "code", "interno", "internal", "cod"]);
    const nameIdx = findCol(headers, ["nome", "label", "name", "designacao", "descricao"]);
    const cityIdx = findCol(headers, ["cidade", "city", "localidade"]);
    const customerIdx = findCol(headers, ["cliente", "customer", "cadeia", "insiginia"]);
    const addressIdx = findCol(headers, ["morada", "address", "endereco"]);
    const postalIdx = findCol(headers, ["postal", "codigopostal", "zipcode", "cp"]);

    // If no code column found, use first column
    if (codeIdx === -1) codeIdx = 0;
    // If no name column, use second column (if exists)
    const finalNameIdx = nameIdx !== -1 ? nameIdx : (rawRows[0].length > 1 ? 1 : -1);

    if (finalNameIdx === -1) {
      return new Response(JSON.stringify({ error: `Estrutura do ficheiro não reconhecida. Colunas: ${rawRows[headerRowIdx].join(", ")}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const report = { created: 0, updated: 0, errors: [] as { row: number; code: string; message: string }[], total_rows: 0 };

    for (let i = dataStartIdx; i < rawRows.length; i++) {
      const row = rawRows[i];
      const rowNum = i + 1;
      const code = (row[codeIdx] || "").trim();
      if (!code) continue;

      report.total_rows++;

      const labelName = (row[finalNameIdx] || "").trim() || code;
      const city = cityIdx !== -1 ? (row[cityIdx] || "").trim() || labelName : labelName;
      const customer = customerIdx !== -1 ? (row[customerIdx] || "").trim() || null : null;
      const address = addressIdx !== -1 ? (row[addressIdx] || "").trim() || null : null;
      const postalCode = postalIdx !== -1 ? (row[postalIdx] || "").trim() || null : null;

      // Upsert by internal_code
      const { data: existing } = await supabase
        .from("delivery_sites")
        .select("id")
        .eq("internal_code", code)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("delivery_sites")
          .update({ label_name: labelName, city, customer_type: customer, address, postal_code: postalCode, active: true })
          .eq("id", existing.id);
        if (error) {
          report.errors.push({ row: rowNum, code, message: error.message });
        } else {
          report.updated++;
        }
      } else {
        const { error } = await supabase
          .from("delivery_sites")
          .insert({ internal_code: code, label_name: labelName, city, customer_type: customer, address, postal_code: postalCode });
        if (error) {
          report.errors.push({ row: rowNum, code, message: error.message });
        } else {
          report.created++;
        }
      }
    }

    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
