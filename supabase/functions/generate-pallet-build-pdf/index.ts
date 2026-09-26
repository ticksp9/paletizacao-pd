import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { cleanStoreName } from "../_shared/resolveStoreName.ts";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const A4_W = 595.28;
const A4_H = 841.89;
const M = 32;

function sanitize(s: string): string {
  return (s || "").replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  let t = sanitize(text);
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + "...", size) > maxWidth) t = t.slice(0, -1);
  return t + "...";
}

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) {
      lines.push(line);
      line = "";
    }

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
      continue;
    }

    let part = "";
    for (const character of word) {
      if (part && font.widthOfTextAtSize(part + character, size) > maxWidth) {
        lines.push(part);
        part = character;
      } else {
        part += character;
      }
    }
    line = part;
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function fmtDate(d: string | null): string {
  if (!d) return "-";
  const s = String(d).slice(0, 10);
  const p = s.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
}

const PALETTE = [
  rgb(0.16, 0.45, 0.78),
  rgb(0.90, 0.49, 0.13),
  rgb(0.20, 0.62, 0.35),
  rgb(0.70, 0.24, 0.55),
  rgb(0.35, 0.35, 0.75),
  rgb(0.85, 0.72, 0.12),
];

interface BoxRow {
  palletization_plan_id: string;
  order_line_id: string | null;
  article_code: string | null;
  store_code: string | null;
  lg_code: string | null;
  layer_number: number | null;
  placement_sequence: number | null;
  pos_x_mm: number | null;
  pos_y_mm: number | null;
  box_length_mm: number | null;
  box_width_mm: number | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authResponse = await requireRole(req, supabase, ["admin", "operador", "etiquetas"], corsHeaders);
    if (authResponse) return authResponse;

    const { order_id } = await req.json();
    if (!order_id || typeof order_id !== "string") {
      return new Response(JSON.stringify({ success: false, error: "order_id em falta." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let userLabel = "-";
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
      const { data: userData } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
      if (userData?.user) {
        const { data: profile } = await supabase
          .from("profiles").select("name, email").eq("user_id", userData.user.id).maybeSingle();
        userLabel = profile?.name || profile?.email || userData.user.email || "-";
      }
    }

    const { data: order } = await supabase
      .from("orders")
      .select("id, order_number, store_code, customer_name, order_date, delivery_date, transport_guide")
      .eq("id", order_id).maybeSingle();
    if (!order) {
      return new Response(JSON.stringify({ success: false, error: "Encomenda não encontrada." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: plans, error: plansError } = await supabase
      .from("palletization_plans")
      .select("id, pallet_number, pallet_size, base_length_mm, base_width_mm, height_mm, total_layers, total_boxes, total_pieces, is_mixed, soc_code, warnings")
      .eq("order_id", order_id)
      .order("pallet_number");

    if (plansError) throw new Error(`Falha a ler planos de paletização: ${plansError.message}`);
    if (!plans || plans.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "Sem plano de paletização. Gere as paletes primeiro." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const planIds = plans.map((p) => p.id);
    const expectedItemCount = plans.reduce((sum, plan) => sum + Number(plan.total_boxes || 0), 0);
    const itemsRaw: BoxRow[] = [];
    const itemPageSize = 500;
    for (let offset = 0; ; offset += itemPageSize) {
      const { data: itemPage, error: itemsError } = await supabase
        .from("pallet_items")
        .select("palletization_plan_id, order_line_id, article_code, store_code, lg_code, layer_number, placement_sequence, pos_x_mm, pos_y_mm, box_length_mm, box_width_mm")
        .in("palletization_plan_id", planIds)
        .order("palletization_plan_id")
        .order("layer_number")
        .order("placement_sequence", { nullsFirst: true })
        .order("pos_y_mm")
        .order("pos_x_mm")
        .range(offset, offset + itemPageSize - 1);
      if (itemsError) throw new Error(`Falha a ler caixas das paletes: ${itemsError.message}`);
      const page = (itemPage || []) as BoxRow[];
      itemsRaw.push(...page);
      if (page.length < itemPageSize) break;
    }
    const actualCounts = new Map<string, number>();
    for (const item of itemsRaw) {
      actualCounts.set(item.palletization_plan_id, (actualCounts.get(item.palletization_plan_id) || 0) + 1);
    }
    const incompletePlans = plans.filter((plan) =>
      (actualCounts.get(plan.id) || 0) !== Number(plan.total_boxes || 0)
    );
    if (itemsRaw.length !== expectedItemCount || incompletePlans.length > 0) {
      throw new Error(
        `Plano incompleto: foram lidas ${itemsRaw.length} de ${expectedItemCount} caixas` +
        `${incompletePlans.length ? `; contagem divergente nas paletes ${incompletePlans.map((plan) => plan.pallet_number).join(", ")}` : ""}. O PDF não foi gerado.`,
      );
    }

    const itemsByPlan = new Map<string, BoxRow[]>();
    for (const it of itemsRaw || []) {
      const arr = itemsByPlan.get(it.palletization_plan_id) || [];
      arr.push(it as BoxRow);
      itemsByPlan.set(it.palletization_plan_id, arr);
    }

    // Descrições dos artigos (linha da encomenda tem prioridade)
    const { data: lines } = await supabase
      .from("order_lines")
      .select("id, article_code, article_description")
      .eq("order_id", order_id);
    const descByLine = new Map<string, string>();
    const descByCode = new Map<string, string>();
    for (const l of lines || []) {
      if (l.article_description) {
        descByLine.set(l.id, String(l.article_description));
        descByCode.set(String(l.article_code), String(l.article_description));
      }
    }

    const warehouse = String(order.store_code || "").trim();
    const warnings: string[] = [];

    // Nome de loja
    const nameCache = new Map<string, string>();
    async function storeName(store: string, lg: string): Promise<string> {
      const key = `${store}|${lg}`;
      const hit = nameCache.get(key);
      if (hit) return hit;
      const locationId = `LG${String(lg || "").replace(/^LG/i, "").trim()}`;
      const fields = "name, customer_label, supermarket_name";
      let row: Record<string, string | null> | null = null;
      if (warehouse && store) {
        const { data } = await supabase
          .from("pd_lg_locations").select(fields)
          .eq("company_id", "01").eq("warehouse_code", warehouse)
          .eq("store_code", store).eq("location_id", locationId).maybeSingle();
        row = data as Record<string, string | null> | null;
        if (!row) {
          const { data: d2 } = await supabase
            .from("pd_lg_locations").select(fields)
            .eq("company_id", "01").eq("warehouse_code", warehouse)
            .eq("store_code", store).limit(1).maybeSingle();
          row = d2 as Record<string, string | null> | null;
        }
      }
      const raw = row?.name || row?.customer_label || row?.supermarket_name || "";
      const name = raw ? cleanStoreName(raw) : `LOJA ${store || "-"}`;
      if (!raw) warnings.push(`Loja ${store || "-"} sem nome no masterdata`);
      nameCache.set(key, name);
      return name;
    }

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages: PDFPage[] = [];

    const newPage = () => {
      const p = pdf.addPage([A4_W, A4_H]);
      pages.push(p);
      return p;
    };

    // ── Capa ──
    const cover = newPage();
    let y = A4_H - M - 10;
    cover.drawText("GUIA DE MONTAGEM DE PALETES", { x: M, y, size: 18, font: bold });
    y -= 28;
    const totalBoxes = plans.reduce((s, p) => s + (p.total_boxes || 0), 0);
    const totalLabels = plans.reduce((sum, plan) => {
      const boxes = itemsByPlan.get(plan.id) || [];
      return sum + new Set(boxes.map((box) => `${box.lg_code}|${box.store_code}`)).size;
    }, 0);
    cover.drawText(
      "ATENÇÃO: este guia fica obsoleto após qualquer repaletização; gere um novo guia.",
      { x: M, y, size: 9, font: bold, color: rgb(0.72, 0.16, 0.08) },
    );
    y -= 17;
    const coverLines = [
      `Encomenda: ${order.order_number}`,
      `Cliente: ${sanitize(order.customer_name || "-")}`,
      `Armazém: ${warehouse || "-"}`,
      `Data de entrega: ${fmtDate(order.delivery_date)}`,
      `Guia de Transporte: ${order.transport_guide || "-"}`,
      `Total de paletes: ${plans.length}`,
      `Total de caixas: ${totalBoxes}`,
    ];
    for (const l of coverLines) {
      cover.drawText(sanitize(l), { x: M, y, size: 11, font });
      y -= 17;
    }
    if (plans.length === 1) {
      cover.drawText(
        fit(bold, "ATENÇÃO: plano de uma única palete; confirmar estabilidade e adequação da carga antes do transporte.", 10, A4_W - 2 * M),
        { x: M, y, size: 10, font: bold, color: rgb(0.72, 0.16, 0.08) },
      );
      y -= 18;
    }
    y -= 8;
    cover.drawText("Montar as paletes pela ordem indicada (LG mais alto para o mais baixo).", {
      x: M, y, size: 10, font, color: rgb(0.35, 0.35, 0.35),
    });
    y -= 26;

    // ── Quadro: paletes necessárias ──
    const bySize = new Map<string, number>();
    for (const p of plans) {
      const s = String(p.pallet_size || "120x80");
      bySize.set(s, (bySize.get(s) || 0) + 1);
    }
    const sizeRows = [...bySize.entries()].sort((a, b) => b[1] - a[1]);
    const boxH = 34 + sizeRows.length * 15 + 22;
    cover.drawRectangle({
      x: M, y: y - boxH, width: A4_W - 2 * M, height: boxH,
      color: rgb(0.96, 0.97, 0.99), borderColor: rgb(0.25, 0.35, 0.5), borderWidth: 1,
    });
    let by = y - 20;
    cover.drawText("PREPARAR ANTES DE MONTAR:", { x: M + 12, y: by, size: 12, font: bold });
    by -= 20;
    for (const [size, count] of sizeRows) {
      cover.drawText(`- ${count} palete${count > 1 ? "s" : ""} ${size} cm`, { x: M + 20, y: by, size: 11, font });
      by -= 15;
    }
    by -= 4;
    cover.drawText(`TOTAL: ${plans.length} paletes | ${totalBoxes} caixas`, {
      x: M + 12, y: by, size: 11, font: bold,
    });
    y -= boxH + 24;

    // ── Tabela-resumo de todas as paletes ──
    cover.drawText("RESUMO DAS PALETES", { x: M, y, size: 12, font: bold });
    y -= 16;
    const cols = [M, M + 52, M + 112, M + 250, M + 350, M + 410, M + 470];
    const heads = ["Palete", "Tamanho", "LG(s)", "Loja(s)", "Caixas", "Altura", "Tipo"];
    const drawCoverTableHeader = (target: PDFPage, targetY: number, continued: boolean) => {
      if (continued) {
        target.drawText("RESUMO DAS PALETES (continuação)", { x: M, y: targetY + 22, size: 12, font: bold });
      }
      target.drawRectangle({ x: M, y: targetY - 4, width: A4_W - 2 * M, height: 16, color: rgb(0.90, 0.92, 0.96) });
      heads.forEach((h, i) => target.drawText(h, { x: cols[i] + 3, y: targetY, size: 9, font: bold }));
    };
    drawCoverTableHeader(cover, y, false);
    y -= 18;

    for (const plan of plans) {
      let tablePage = cover;
      if (y < M + 30) {
        tablePage = newPage();
        y = A4_H - M - 20;
        drawCoverTableHeader(tablePage, y, true);
        y -= 18;
      }
      const items = itemsByPlan.get(plan.id) || [];
      const lgs = [...new Set(items.map((i) => String(i.lg_code || "").replace(/^LG/i, "")).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
      const stores = [...new Set(items.map((i) => String(i.store_code || "")).filter(Boolean))];
      const vals = [
        String(plan.pallet_number),
        `${plan.pallet_size || "120x80"}`,
        lgs.map((l) => `LG${l}`).join("+") || "-",
        stores.join("+") || "-",
        String(plan.total_boxes || items.length),
        `${(((plan.height_mm || 0) as number) / 1000).toFixed(2).replace(".", ",")}m`,
        plan.is_mixed ? "MISTA" : "Dedicada",
      ];
      vals.forEach((v, i) => {
        const maxW = (cols[i + 1] ?? A4_W - M) - cols[i] - 6;
        tablePage.drawText(fit(font, v, 9, maxW), {
          x: cols[i] + 3, y, size: 9, font,
          color: i === 6 && plan.is_mixed ? rgb(0.8, 0.1, 0.1) : rgb(0, 0, 0),
        });
      });
      y -= 14;
    }

    // ── Avisos visíveis imediatamente para cada palete ──
    for (const plan of plans) {
      const boxes = itemsByPlan.get(plan.id) || [];
      const planWarnings: string[] = Array.isArray(plan.warnings) ? plan.warnings as string[] : [];
      const stores = [...new Set(boxes.map((b) => String(b.store_code || "")).filter(Boolean))];
      const lgs = [...new Set(boxes.map((b) => String(b.lg_code || "").replace(/^LG/i, "").trim()).filter(Boolean))]
        .sort((a, b) => Number(b) - Number(a));
      const warningPage = newPage();
      warningPage.drawRectangle({
        x: 0, y: A4_H - 58, width: A4_W, height: 58,
        color: planWarnings.length ? rgb(0.99, 0.88, 0.84) : rgb(0.88, 0.96, 0.89),
      });
      warningPage.drawText(
        `PALETE ${plan.pallet_number} de ${plans.length} — ${plan.pallet_size || "120x80"}cm — ${(((plan.height_mm || 0) as number) / 1000).toFixed(2).replace(".", ",")}m`,
        { x: M, y: A4_H - 32, size: 14, font: bold, color: planWarnings.length ? rgb(0.65, 0.17, 0.08) : rgb(0.12, 0.38, 0.25) },
      );
      warningPage.drawText(
        fit(
          font,
          sanitize(`${plan.total_boxes || boxes.length} caixas · ${plan.total_layers || 0} camadas · Lojas ${stores.join(", ") || "-"} · ${lgs.map((lg) => `LG${lg}`).join(", ") || "LG -"}`),
          9,
          A4_W - 2 * M,
        ),
        { x: M, y: A4_H - 48, size: 9, font, color: rgb(0.25, 0.25, 0.25) },
      );
      warningPage.drawText(
        "Guia obsoleto após repaletização; gerar novamente.",
        { x: M, y: A4_H - 63, size: 8, font: bold, color: rgb(0.65, 0.17, 0.08) },
      );

      const warningWidth = A4_W - 2 * M - 24;
      const warningBottom = M + 30;
      const warningColor = planWarnings.length ? rgb(1, 0.96, 0.93) : rgb(0.94, 0.98, 0.95);
      const warningBorder = planWarnings.length ? rgb(0.78, 0.31, 0.19) : rgb(0.25, 0.58, 0.35);
      warningPage.drawRectangle({
        x: M, y: warningBottom, width: A4_W - 2 * M,
        height: A4_H - 68 - warningBottom, color: warningColor,
        borderColor: warningBorder, borderWidth: 1.2,
      });
      warningPage.drawText("AVISOS — verificar antes de iniciar", {
        x: M + 12, y: A4_H - 89, size: 11, font: bold,
        color: planWarnings.length ? rgb(0.65, 0.17, 0.08) : rgb(0.12, 0.38, 0.25),
      });
      const warningLines = planWarnings.length
        ? planWarnings.flatMap((text, index) => [
          ...wrapText(font, `${index + 1}. ${text}`, 10, warningWidth),
          "",
        ])
        : ["Sem avisos registados para esta palete."];
      let warningLineIndex = 0;
      let currentWarningPage: PDFPage = warningPage;
      let warningY = A4_H - 108;

      const startWarningContinuation = () => {
        currentWarningPage = newPage();
        currentWarningPage.drawRectangle({
          x: 0, y: A4_H - 58, width: A4_W, height: 58,
          color: rgb(0.99, 0.88, 0.84),
        });
        currentWarningPage.drawText(
          `AVISOS — PALETE ${plan.pallet_number} de ${plans.length} (continuação)`,
          { x: M, y: A4_H - 34, size: 13, font: bold, color: rgb(0.65, 0.17, 0.08) },
        );
        currentWarningPage.drawRectangle({
          x: M, y: warningBottom, width: A4_W - 2 * M,
          height: A4_H - 68 - warningBottom, color: warningColor,
          borderColor: warningBorder, borderWidth: 1.2,
        });
        warningY = A4_H - 88;
      };

      while (warningLineIndex < warningLines.length) {
        const line = warningLines[warningLineIndex];
        if (warningY < warningBottom) startWarningContinuation();
        if (line) {
          currentWarningPage.drawText(line, {
            x: M + 12, y: warningY, size: 10, font,
            color: planWarnings.length ? rgb(0.38, 0.16, 0.12) : rgb(0.12, 0.38, 0.25),
          });
        }
        warningY -= line ? 14 : 6;
        warningLineIndex++;
      }

      // A página seguinte contém os pormenores de montagem da palete.
      const page = newPage();
      let py = A4_H - M;
      const outOfBase = boxes.some((b: any) =>
        (b.pos_x_mm ?? 0) < 0 || (b.pos_y_mm ?? 0) < 0 ||
        (b.pos_x_mm ?? 0) + (b.box_length_mm ?? 0) > (plan.base_length_mm ?? 1200) ||
        (b.pos_y_mm ?? 0) + (b.box_width_mm ?? 0) > (plan.base_width_mm ?? 800)
      );
      const needsCheck = outOfBase || planWarnings.some((w) => /fora da base|contenc|conten|sobrepost/i.test(w));

      page.drawRectangle({ x: 0, y: A4_H - 58, width: A4_W, height: 58, color: needsCheck ? rgb(0.99, 0.9, 0.9) : rgb(0.94, 0.96, 0.99) });
      if (needsCheck) {
        page.drawText("! VERIFICAR MONTAGEM", { x: A4_W - M - 150, y: A4_H - 30, size: 12, font: bold, color: rgb(0.8, 0.1, 0.1) });
      }
      page.drawText(
        `PALETE ${plan.pallet_number} de ${plans.length} — Tamanho ${plan.pallet_size || "120x80"}cm — Altura final ${(((plan.height_mm || 0) / 1000)).toFixed(2)}m`,
        { x: M, y: A4_H - 30, size: 13, font: bold },
      );
      page.drawText(
        sanitize(`${plan.total_boxes || 0} caixas · ${plan.total_layers || 0} camadas${plan.is_mixed ? " · PALETE MISTA" : ""}${plan.soc_code ? ` · SOC ${plan.soc_code}` : ""}`),
        { x: M, y: A4_H - 48, size: 10, font, color: rgb(0.3, 0.3, 0.3) },
      );
      py = A4_H - 74;

      // Grupos (artigo × loja × lg) por ordem de colocação (camada mínima)
      const groups = new Map<string, {
        article: string; store: string; lg: string; count: number;
        minLayer: number; maxLayer: number; lineId: string | null;
      }>();
      for (const b of boxes) {
        const key = `${b.article_code}|${b.store_code}|${b.lg_code}`;
        const g = groups.get(key);
        const layer = b.layer_number || 1;
        if (g) {
          g.count++;
          g.minLayer = Math.min(g.minLayer, layer);
          g.maxLayer = Math.max(g.maxLayer, layer);
        } else {
          groups.set(key, {
            article: String(b.article_code || "-"),
            store: String(b.store_code || "-"),
            lg: String(b.lg_code || "-"),
            count: 1, minLayer: layer, maxLayer: layer,
            lineId: b.order_line_id,
          });
        }
      }
      const groupList = Array.from(groups.values()).sort((a, b) => a.minLayer - b.minLayer);

      // Instruções, tabela e diagramas são paginados em secções próprias.
      const names = new Map<string, string>();
      for (const g of groupList) names.set(g.store, await storeName(g.store, g.lg));

      const detailSectionPage = (section: string): { page: PDFPage; y: number } => {
        const p = newPage();
        p.drawRectangle({ x: 0, y: A4_H - 58, width: A4_W, height: 58, color: rgb(0.94, 0.96, 0.99) });
        p.drawText(`PALETE ${plan.pallet_number} — ${section}`, {
          x: M, y: A4_H - 32, size: 13, font: bold,
        });
        p.drawText(`${plan.total_boxes || boxes.length} caixas · ${plan.total_layers || 0} camadas`, {
          x: M, y: A4_H - 48, size: 9, font,
        });
        return { page: p, y: A4_H - 78 };
      };

      let directionsPage = page;
      let directionsY = py;
      directionsPage.drawText("NESTA PALETE COLOCAR:", { x: M, y: directionsY, size: 11, font: bold });
      directionsY -= 17;
      let step = 0;
      for (const g of groupList) {
        step++;
        const desc = (g.lineId && descByLine.get(g.lineId)) || descByCode.get(g.article) || "";
        const txt = `${step}º colocar ${g.count} caixas do artigo ${g.article}${desc ? ` (${desc})` : ""} — LG${g.lg.replace(/^LG/i, "")} / Loja ${g.store} ${names.get(g.store) || ""} — camadas ${g.minLayer}${g.maxLayer !== g.minLayer ? `–${g.maxLayer}` : ""}`;
        const lines = wrapText(font, txt, 9, A4_W - 2 * M);
        for (const line of lines) {
          if (directionsY < M + 18) {
            const next = detailSectionPage("INSTRUÇÕES (continuação)");
            directionsPage = next.page;
            directionsY = next.y;
          }
          directionsPage.drawText(line, { x: M, y: directionsY, size: 9, font });
          directionsY -= 13;
        }
      }

      // Tabela completa com cabeçalho repetido nas páginas de continuação.
      const cols = [
        { t: "Camada", x: M, w: 52 },
        { t: "Artigo (EAN)", x: M + 52, w: 96 },
        { t: "Descrição", x: M + 148, w: 175 },
        { t: "Loja", x: M + 323, w: 42 },
        { t: "Nome da Loja", x: M + 365, w: 110 },
        { t: "LG", x: M + 475, w: 40 },
        { t: "Caixas", x: M + 515, w: 45 },
      ];
      let tablePage: PDFPage = page;
      let tableY = 0;
      const drawGroupTableHeader = (continued: boolean) => {
        const section = detailSectionPage(`GRUPOS POR CAMADA${continued ? " (continuação)" : ""}`);
        tablePage = section.page;
        tableY = section.y;
        tablePage.drawRectangle({ x: M, y: tableY - 4, width: A4_W - 2 * M, height: 16, color: rgb(0.90, 0.92, 0.95) });
        for (const c of cols) tablePage.drawText(c.t, { x: c.x + 2, y: tableY, size: 8, font: bold });
        tableY -= 18;
      };
      drawGroupTableHeader(false);
      for (const g of groupList) {
        if (tableY < M + 20) drawGroupTableHeader(true);
        const desc = (g.lineId && descByLine.get(g.lineId)) || descByCode.get(g.article) || "-";
        const vals = [
          g.minLayer === g.maxLayer ? `${g.minLayer}` : `${g.minLayer}-${g.maxLayer}`,
          g.article,
          desc,
          g.store,
          names.get(g.store) || "-",
          `LG${g.lg.replace(/^LG/i, "")}`,
          String(g.count),
        ];
        vals.forEach((v, i) => {
          tablePage.drawText(fit(font, v, 8, cols[i].w - 4), { x: cols[i].x + 2, y: tableY, size: 8, font });
        });
        tableY -= 13;
      }

      // Um diagrama por página garante que nenhuma camada ou caixa desaparece.
      const baseL = plan.base_length_mm || 1200;
      const baseW = plan.base_width_mm || 800;
      const layerNums = [...new Set(boxes.map((b) => b.layer_number || 1))].sort((a, b) => a - b);
      const colorByKey = new Map<string, number>();
      groupList.forEach((g, i) => colorByKey.set(`${g.article}|${g.store}|${g.lg}`, i % PALETTE.length));
      const diagW = Math.min(A4_W - 2 * M, 360);
      const scale = diagW / baseL;
      const diagH = baseW * scale;
      for (const ln of layerNums) {
        const diagramPage = newPage();
        diagramPage.drawRectangle({ x: 0, y: A4_H - 58, width: A4_W, height: 58, color: rgb(0.94, 0.96, 0.99) });
        diagramPage.drawText(`PALETE ${plan.pallet_number} — VISTA DE TOPO, CAMADA ${ln}`, {
          x: M, y: A4_H - 32, size: 13, font: bold,
        });
        const dx = M;
        const dy = A4_H - 100 - diagH;
        diagramPage.drawRectangle({ x: dx, y: dy, width: diagW, height: diagH, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 0.8 });
        for (const b of boxes.filter((x) => (x.layer_number || 1) === ln)) {
          const bl = (b.box_length_mm || 400) * scale;
          const bw = (b.box_width_mm || 300) * scale;
          const ci = colorByKey.get(`${b.article_code}|${b.store_code}|${b.lg_code}`) ?? 0;
          diagramPage.drawRectangle({
            x: dx + (b.pos_x_mm || 0) * scale,
            y: dy + (b.pos_y_mm || 0) * scale,
            width: Math.max(1, bl - 0.6),
            height: Math.max(1, bw - 0.6),
            color: PALETTE[ci],
            opacity: 0.55,
            borderColor: rgb(0.2, 0.2, 0.2),
            borderWidth: 0.3,
          });
        }
      }

      // Camada ascendente (base primeiro). Planos novos seguem a sequência
      // efetiva de colocação persistida; os antigos recorrem a LG/Y/X.
      const sequenceLayers = [...new Set(boxes.map((b) => b.layer_number || 1))].sort((a, b) => a - b);
      const hasLegacySequence = boxes.some((box) =>
        box.placement_sequence == null || !Number.isInteger(box.placement_sequence)
      );
      const sequenceBottom = M + 18;
      const sequenceLineHeight = 13;
      const sequenceWidth = A4_W - 2 * M - 12;

      for (const layer of sequenceLayers) {
        const layerBoxes = boxes
          .map((box, index) => ({ box, index }))
          .filter(({ box }) => (box.layer_number || 1) === layer);
        const hasCompleteSequence = layerBoxes.every(({ box }) =>
          box.placement_sequence != null && Number.isInteger(box.placement_sequence)
        );
        layerBoxes.sort((a, b) => {
          if (hasCompleteSequence) {
            return a.box.placement_sequence! - b.box.placement_sequence! || a.index - b.index;
          }
          const aLg = String(a.box.lg_code || "").replace(/^LG/i, "").trim();
          const bLg = String(b.box.lg_code || "").replace(/^LG/i, "").trim();
          const aLgNumber = Number(aLg);
          const bLgNumber = Number(bLg);
          let lgOrder = 0;
          if (!aLg && bLg) lgOrder = 1;
          else if (aLg && !bLg) lgOrder = -1;
          else if (Number.isFinite(aLgNumber) && Number.isFinite(bLgNumber) && aLgNumber !== bLgNumber) {
            lgOrder = bLgNumber - aLgNumber;
          } else {
            lgOrder = bLg.localeCompare(aLg, undefined, { numeric: true, sensitivity: "base" });
          }
          return lgOrder ||
            (a.box.pos_y_mm ?? 0) - (b.box.pos_y_mm ?? 0) ||
            (a.box.pos_x_mm ?? 0) - (b.box.pos_x_mm ?? 0) ||
            String(a.box.store_code || "").localeCompare(String(b.box.store_code || ""), undefined, { numeric: true }) ||
            String(a.box.article_code || "").localeCompare(String(b.box.article_code || ""), undefined, { numeric: true }) ||
            a.index - b.index;
        });

        let sequencePage: PDFPage | null = null;
        let sequenceY = 0;
        const startSequencePage = (continued: boolean) => {
          const p = newPage();
          p.drawRectangle({ x: 0, y: A4_H - 72, width: A4_W, height: 72, color: rgb(0.91, 0.96, 0.93) });
          p.drawText(
            `SEQUÊNCIA DE COLOCAÇÃO — PALETE ${plan.pallet_number} — CAMADA ${layer}${continued ? " (continuação)" : ""}`,
            { x: M, y: A4_H - 25, size: 12, font: bold, color: rgb(0.12, 0.38, 0.25) },
          );
          p.drawText("Camada 1 = base; montar as camadas em ordem crescente.", {
            x: M, y: A4_H - 42, size: 8, font, color: rgb(0.25, 0.3, 0.27),
          });
          p.drawText(
            hasLegacySequence
              ? "Plano antigo: ordem aproximada LG/Y/X; não representa a sequência física de colocação nem uma espiral certificada."
              : "Sequência de colocação registada; preferência horária em anéis, podendo ser interrompida por dimensões e apoio.",
            {
              x: M, y: A4_H - 54, size: 8, font, color: rgb(0.25, 0.3, 0.27),
            },
          );
          p.drawText("X/Y em mm a partir da origem (0,0) do plano; confirmar a disposição física na palete.", {
            x: M, y: A4_H - 66, size: 8, font, color: rgb(0.25, 0.3, 0.27),
          });
          sequenceY = A4_H - 88;
          sequencePage = p;
        };

        for (let itemIndex = 0; itemIndex < layerBoxes.length; itemIndex++) {
          const box = layerBoxes[itemIndex].box;
          const lg = String(box.lg_code || "-").replace(/^LG/i, "");
          const x = box.pos_x_mm != null && Number.isFinite(box.pos_x_mm) ? `X${box.pos_x_mm}` : "X?";
          const y = box.pos_y_mm != null && Number.isFinite(box.pos_y_mm) ? `Y${box.pos_y_mm}` : "Y?";
          const instruction = `${itemIndex + 1}. LG${lg || "-"} | Loja ${box.store_code || "-"} | Artigo ${box.article_code || "-"} | ${x}/${y}`;
          const lines = wrapText(font, instruction, 10, sequenceWidth);

          for (const line of lines) {
            if (!sequencePage || sequenceY < sequenceBottom) {
              startSequencePage(sequencePage !== null);
            }
            sequencePage!.drawText(line, {
              x: M + 6,
              y: sequenceY,
              size: 10,
              font,
              color: rgb(0.12, 0.18, 0.15),
            });
            sequenceY -= sequenceLineHeight;
          }
        }
      }

      // Avisos em páginas próprias: preserva o texto integral e pagina listas longas.
      if (planWarnings.length > 0) {
        let warningPage: PDFPage | null = null;
        let warningY = 0;
        const warningBottom = M + 18;
        const warningLineHeight = 13;
        const warningWidth = A4_W - 2 * M - 12;

        const startWarningPage = (continued: boolean) => {
          const p = newPage();
          p.drawRectangle({ x: 0, y: A4_H - 58, width: A4_W, height: 58, color: rgb(0.99, 0.93, 0.87) });
          p.drawText(
            `AVISOS — PALETE ${plan.pallet_number} de ${plans.length}${continued ? " (continuação)" : ""}`,
            { x: M, y: A4_H - 34, size: 13, font: bold, color: rgb(0.65, 0.25, 0.05) },
          );
          warningY = A4_H - 76;
          warningPage = p;
        };

        for (let warningIndex = 0; warningIndex < planWarnings.length; warningIndex++) {
          const lines = wrapText(font, `${warningIndex + 1}. ${planWarnings[warningIndex]}`, 10, warningWidth);
          for (const line of lines) {
            if (!warningPage || warningY < warningBottom) {
              startWarningPage(warningPage !== null);
            }
            warningPage!.drawText(line, {
              x: M + 6,
              y: warningY,
              size: 10,
              font,
              color: rgb(0.2, 0.15, 0.1),
            });
            warningY -= warningLineHeight;
          }
          warningY -= 7;
        }
      }
    }

    // ── Página resumo ──
    let summary = newPage();
    let sy = A4_H - M - 6;
    const scols = [
      { t: "Palete", x: M, w: 44 },
      { t: "Tamanho", x: M + 44, w: 60 },
      { t: "LG(s)", x: M + 104, w: 110 },
      { t: "Lojas", x: M + 214, w: 110 },
      { t: "Caixas", x: M + 324, w: 48 },
      { t: "Altura", x: M + 372, w: 52 },
      { t: "Etiquetas", x: M + 424, w: 100 },
    ];
    const drawSummaryHeader = (continued: boolean) => {
      summary.drawText(
        continued ? "MAPA RESUMO DE PALETES (continuação)" : "MAPA RESUMO DE PALETES",
        { x: M, y: sy, size: 14, font: bold },
      );
      sy -= 22;
      summary.drawRectangle({ x: M, y: sy - 4, width: A4_W - 2 * M, height: 16, color: rgb(0.90, 0.92, 0.95) });
      for (const c of scols) summary.drawText(c.t, { x: c.x + 2, y: sy, size: 8, font: bold });
      sy -= 18;
    };
    drawSummaryHeader(false);

    for (const plan of plans) {
      if (sy < M + 30) {
        summary = newPage();
        sy = A4_H - M - 6;
        drawSummaryHeader(true);
      }
      const boxes = itemsByPlan.get(plan.id) || [];
      const lgs = [...new Set(boxes.map((b) => `LG${String(b.lg_code || "").replace(/^LG/i, "")}`))];
      const stores = [...new Set(boxes.map((b) => String(b.store_code || "-")))];
      const labels = new Set(boxes.map((b) => `${b.lg_code}|${b.store_code}`)).size;
      const vals = [
        String(plan.pallet_number),
        `${plan.pallet_size || "120x80"}cm`,
        lgs.join(", "),
        stores.join(", "),
        String(plan.total_boxes || 0),
        `${(((plan.height_mm || 0) / 1000)).toFixed(2)}m`,
        `${labels} etiqueta(s)`,
      ];
      vals.forEach((v, i) => {
        summary.drawText(fit(font, v, 8, scols[i].w - 4), { x: scols[i].x + 2, y: sy, size: 8, font });
      });
      sy -= 13;
    }
    if (sy < M + 24) {
      summary = newPage();
      sy = A4_H - M - 28;
      summary.drawText("MAPA RESUMO DE PALETES (continuação)", { x: M, y: sy, size: 14, font: bold });
      sy -= 22;
    }
    sy -= 8;
    summary.drawText(
      sanitize(`TOTAL: ${plans.length} paletes · ${totalBoxes} caixas · ${totalLabels} etiquetas`),
      { x: M, y: sy, size: 10, font: bold },
    );

    // ── Rodapés ──
    const stamp = new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });
    pages.forEach((p, i) => {
      p.drawText(
        fit(font, `Gerado em ${stamp} por ${userLabel} — Página ${i + 1} de ${pages.length}`, 7, A4_W - 2 * M),
        { x: M, y: 18, size: 7, font, color: rgb(0.4, 0.4, 0.4) },
      );
    });

    const bytes = await pdf.save();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${order_id}/montagem_paletes_${String(order.order_number).replace(/[^A-Za-z0-9._-]/g, "_")}_${ts}.pdf`;

    const { error: upErr } = await supabase.storage.from("exports").upload(path, bytes, {
      contentType: "application/pdf", upsert: true,
    });
    if (upErr) throw new Error(`Falha no upload: ${upErr.message}`);

    const { data: signed, error: signErr } = await supabase.storage
      .from("exports").createSignedUrl(path, 3600);
    if (signErr || !signed) throw new Error(`Falha a criar link: ${signErr?.message}`);

    return new Response(
      JSON.stringify({
        success: true,
        pdf_url: signed.signedUrl,
        pages: pages.length,
        totals: { pallets: plans.length, boxes: totalBoxes, labels: totalLabels },
        warnings: [...new Set(warnings)],
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("generate-pallet-build-pdf:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
