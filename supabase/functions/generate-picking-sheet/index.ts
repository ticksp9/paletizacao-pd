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

interface Row {
  ean: string;
  description: string;
  store_code: string;
  store_name: string;
  lg_code: string;
  line_number: number;
  per_box: number | null;
  boxes: number;
  units: number;
}

function sanitize(s: string): string {
  // WinAnsi-safe text for standard fonts
  return (s || "").replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  let t = sanitize(text);
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + "...", size) > maxWidth) t = t.slice(0, -1);
  return t + "...";
}

function fmtDate(d: string | null): string {
  if (!d) return "—".replace("—", "-");
  const s = String(d).slice(0, 10);
  const p = s.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
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

    const { order_id, mode: rawMode } = await req.json();
    const sheetMode: "per_lg" | "single_page" | "soc" =
      rawMode === "single_page" ? "single_page" : rawMode === "soc" ? "soc" : "per_lg";
    if (!order_id || typeof order_id !== "string") {
      return new Response(JSON.stringify({ success: false, error: "order_id em falta." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Who is generating (for footer)
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

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, order_number, store_code, customer_name, order_date, delivery_date, transport_guide")
      .eq("id", order_id).maybeSingle();
    if (orderErr) throw new Error(orderErr.message);
    if (!order) {
      return new Response(JSON.stringify({ success: false, error: "Encomenda não encontrada." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: lines, error: linesErr } = await supabase
      .from("order_lines")
      .select("line_number, article_code, article_description, store_code, lg_code, warehouse_code, quantity, quantity_cases")
      .eq("order_id", order_id)
      .order("line_number", { ascending: true });
    if (linesErr) throw new Error(linesErr.message);
    if (!lines || lines.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "Sem dados para gerar o mapa de conferência." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const orderWarehouse = String(order.store_code || "").trim();
    const warnings: string[] = [];

    // ── Articles lookup (pieces per box) by EAN or code ──
    const codes = Array.from(new Set(lines.map((l) => String(l.article_code || "").trim()).filter(Boolean)));
    const artByKey = new Map<string, { description: string; pieces_per_box: number | null }>();
    if (codes.length > 0) {
      const { data: arts } = await supabase
        .from("articles").select("code, ean, description, pieces_per_box")
        .or(`ean.in.(${codes.join(",")}),code.in.(${codes.join(",")})`);
      for (const a of arts || []) {
        const entry = { description: String(a.description || ""), pieces_per_box: a.pieces_per_box ?? null };
        if (a.ean) artByKey.set(String(a.ean).trim(), entry);
        if (a.code) artByKey.set(String(a.code).trim(), entry);
      }
    }

    // ── Store name lookup (query-only) ──
    const nameCache = new Map<string, string>();
    async function storeName(warehouse: string, store: string, lg: string): Promise<string> {
      const key = `${warehouse}|${store}|${lg}`;
      const hit = nameCache.get(key);
      if (hit) return hit;
      const locationId = `LG${String(lg || "").replace(/^LG/i, "").trim()}`;
      const fields = "name, customer_label, supermarket_name";
      let row: Record<string, unknown> | null = null;

      if (warehouse && store) {
        const { data } = await supabase.from("pd_lg_locations").select(fields)
          .eq("company_id", "01").eq("warehouse_code", warehouse)
          .eq("store_code", store).eq("location_id", locationId)
          .eq("active", true).limit(1).maybeSingle();
        row = data || null;
        if (!row) {
          const { data: d2 } = await supabase.from("pd_lg_locations").select(fields)
            .eq("company_id", "01").eq("warehouse_code", warehouse)
            .eq("store_code", store).eq("active", true).limit(1).maybeSingle();
          row = d2 || null;
        }
      }

      let name = "";
      if (row) {
        const raw = String(row.name || row.customer_label || row.supermarket_name || "").trim();
        name = cleanStoreName(raw);
      }
      if (!name) {
        name = `LOJA ${store || "?"}`;
        const w = `Loja sem nome no masterdata: Armazém ${warehouse || "-"} / Loja ${store || "-"} / ${locationId}`;
        if (!warnings.includes(w)) warnings.push(w);
      }
      nameCache.set(key, name);
      return name;
    }

    // ── Build rows ──
    const rows: Row[] = [];
    for (const l of lines) {
      const ean = String(l.article_code || "").trim();
      const art = artByKey.get(ean);
      const store = String(l.store_code || "").trim();
      const lg = String(l.lg_code || "").trim();
      const warehouse = String(l.warehouse_code || "").trim() || orderWarehouse;
      const units = Number(l.quantity || 0);
      const cases = l.quantity_cases != null ? Number(l.quantity_cases) : null;

      let perBox: number | null = art?.pieces_per_box ?? null;
      if ((!perBox || perBox <= 0) && cases && cases > 0) perBox = Math.round(units / cases);
      if (!perBox || perBox <= 0) {
        perBox = null;
        const w = `Artigo ${ean || "-"} sem peças por caixa (nem caixas na encomenda).`;
        if (!warnings.includes(w)) warnings.push(w);
      }

      const boxes = cases != null && cases > 0
        ? Math.round(cases)
        : (perBox ? Math.ceil(units / perBox) : 0);

      rows.push({
        ean,
        description: String(l.article_description || art?.description || ""),
        store_code: store,
        store_name: await storeName(warehouse, store, lg),
        lg_code: lg,
        line_number: Number(l.line_number || 0),
        per_box: perBox,
        boxes,
        units,
      });
    }

    // ── LISTA DE CAIXAS (SOC) ──
    // Uma linha por caixa, pela ordem das etiquetas (palete, LG decrescente, loja, SOC), para
    // saber que artigo e que quantidade vão dentro de cada caixa/etiqueta.
    if (sheetMode === "soc") {
      const { data: plans, error: plansErr } = await supabase
        .from("palletization_plans")
        .select("id, pallet_number, soc_code")
        .eq("order_id", order_id)
        .order("pallet_number", { ascending: true });
      if (plansErr) throw new Error(plansErr.message);
      if (!plans || plans.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "A encomenda ainda não tem paletes. Paletize primeiro." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const planIds = plans.map((p) => p.id);
      const palletNumberByPlan = new Map(plans.map((p) => [p.id, Number(p.pallet_number)]));
      const planSocByPlan = new Map(plans.map((p) => [p.id, String(p.soc_code || "").trim()]));

      const { data: items, error: itemsErr } = await supabase
        .from("pallet_items")
        .select("id, palletization_plan_id, order_line_id, store_code, lg_code, article_code, soc_code, layer_number, placement_sequence")
        .in("palletization_plan_id", planIds);
      if (itemsErr) throw new Error(itemsErr.message);
      const { data: containers } = await supabase
        .from("pallet_store_containers")
        .select("palletization_plan_id, store_code, soc_code")
        .in("palletization_plan_id", planIds);
      const containerSoc = new Map(
        (containers || []).map((c) => [`${c.palletization_plan_id}|${String(c.store_code).trim()}`, String(c.soc_code || "").trim()]),
      );

      const { data: fullLines, error: fullLinesErr } = await supabase
        .from("order_lines")
        .select("id, article_code, article_description, store_code, lg_code, warehouse_code, quantity, quantity_cases")
        .eq("order_id", order_id);
      if (fullLinesErr) throw new Error(fullLinesErr.message);
      const lineById = new Map((fullLines || []).map((l) => [l.id, l]));

      interface BoxRow {
        pallet: number; soc: string; store: string; storeName: string; lg: string;
        ean: string; description: string; qty: number; lineId: string;
      }
      const boxes: BoxRow[] = [];
      let missingSoc = false;
      for (const it of items || []) {
        const line = it.order_line_id ? lineById.get(it.order_line_id) : undefined;
        const store = String(it.store_code || line?.store_code || "").trim();
        const lg = String(it.lg_code || line?.lg_code || "").trim();
        const ean = String(it.article_code || line?.article_code || "").trim();
        const warehouse = String(line?.warehouse_code || "").trim() || orderWarehouse;
        let soc = String(it.soc_code || "").trim();
        if (!soc) {
          soc = containerSoc.get(`${it.palletization_plan_id}|${store}`) || planSocByPlan.get(it.palletization_plan_id) || "";
          missingSoc = true;
        }
        boxes.push({
          pallet: palletNumberByPlan.get(it.palletization_plan_id) ?? 0,
          soc,
          store,
          storeName: await storeName(warehouse, store, lg),
          lg,
          ean,
          description: String(line?.article_description || artByKey.get(ean)?.description || ""),
          qty: 0,
          lineId: String(it.order_line_id || ""),
        });
      }
      if (missingSoc) {
        warnings.push("Esta encomenda foi paletizada antes da regra 'um SOC por caixa'. Use «Refazer encomenda» para dar um SOC a cada caixa.");
      }

      // Quantidade em cada caixa: caixas cheias e a última leva o resto (igual ao ficheiro DESADV).
      const boxesByLine = new Map<string, BoxRow[]>();
      for (const b of boxes) {
        if (!boxesByLine.has(b.lineId)) boxesByLine.set(b.lineId, []);
        boxesByLine.get(b.lineId)!.push(b);
      }
      for (const [lineId, lineBoxes] of boxesByLine) {
        const line = lineById.get(lineId);
        let remaining = Number(line?.quantity || 0);
        const ppb = artByKey.get(String(line?.article_code || "").trim())?.pieces_per_box
          || (line?.quantity_cases ? Math.round(Number(line.quantity) / Number(line.quantity_cases)) : 0)
          || Math.ceil(remaining / Math.max(1, lineBoxes.length));
        lineBoxes.sort((a, b) => a.soc.localeCompare(b.soc, "pt", { numeric: true }));
        lineBoxes.forEach((b, i) => {
          const q = i === lineBoxes.length - 1 ? remaining : Math.min(ppb, remaining);
          b.qty = Math.max(0, q);
          remaining -= b.qty;
        });
      }

      const lgNum = (lg: string) => parseInt(lg.replace(/\D/g, ""), 10) || 0;
      boxes.sort((a, b) =>
        lgNum(b.lg) - lgNum(a.lg) ||
        (parseInt(a.store, 10) || 0) - (parseInt(b.store, 10) || 0) ||
        a.soc.localeCompare(b.soc, "pt", { numeric: true })
      );

      const pdfS = await PDFDocument.create();
      const fS = await pdfS.embedFont(StandardFonts.Helvetica);
      const bS = await pdfS.embedFont(StandardFonts.HelveticaBold);
      const mS = await pdfS.embedFont(StandardFonts.Courier);
      const mbS = await pdfS.embedFont(StandardFonts.CourierBold);
      const PW = A4_H, PH = A4_W; // horizontal
      const MG = 28;
      const usableW = PW - MG * 2;
      // Sem coluna de palete por agora (pedido do utilizador); a ordem é a das etiquetas por LG.
      const colW = [0.13, 0.06, 0.19, 0.07, 0.13, 0.30, 0.07, 0.05].map((p) => p * usableW);
      const colLabels = ["SOC", "Loja", "Nome da loja", "LG", "Artigo (EAN)", "Descrição", "Qtd. cx", "Conf."];
      const colAlign: Array<"left" | "right" | "center"> = ["left", "left", "left", "left", "left", "left", "right", "center"];
      const colX: number[] = [];
      { let acc = MG; for (const w of colW) { colX.push(acc); acc += w; } }
      const ROW = 15;
      const cell = (page: PDFPage, c: number, text: string, y: number, f: PDFFont, s: number, color = rgb(0.1, 0.1, 0.1)) => {
        const t = fit(f, text, s, colW[c] - 6);
        const w = f.widthOfTextAtSize(t, s);
        const x = colAlign[c] === "right" ? colX[c] + colW[c] - 3 - w
          : colAlign[c] === "center" ? colX[c] + (colW[c] - w) / 2 : colX[c] + 3;
        page.drawText(t, { x, y, size: s, font: f, color });
      };
      const nowS = new Date();
      const genS = `${String(nowS.getDate()).padStart(2, "0")}/${String(nowS.getMonth() + 1).padStart(2, "0")}/${nowS.getFullYear()} ${String(nowS.getHours()).padStart(2, "0")}:${String(nowS.getMinutes()).padStart(2, "0")}`;
      const pagesS: PDFPage[] = [];
      const header = () => {
        const page = pdfS.addPage([PW, PH]);
        pagesS.push(page);
        let y = PH - MG - 12;
        page.drawText(fit(bS, `LISTA DE CAIXAS E SOC - Encomenda ${sanitize(String(order.order_number || "-"))}`, 14, usableW), { x: MG, y, size: 14, font: bS });
        y -= 15;
        page.drawText(fit(fS, `Armazem ${orderWarehouse || "-"} | Entrega: ${order.delivery_date ? fmtDate(order.delivery_date) : "-"} | Guia: ${order.transport_guide || "-"} | ${boxes.length} caixas`, 9, usableW), { x: MG, y, size: 9, font: fS, color: rgb(0.3, 0.3, 0.3) });
        y -= 20;
        page.drawRectangle({ x: MG, y: y - 4, width: usableW, height: 15, color: rgb(0.88, 0.9, 0.94) });
        for (let c = 0; c < colLabels.length; c++) cell(page, c, colLabels[c], y, bS, 8.5);
        return { page, y: y - ROW - 2 };
      };

      let { page: pg, y } = header();
      let shade = false;
      let i = 0;
      let totalUnits = 0;
      while (i < boxes.length) {
        const groupKey = boxes[i].store;
        let gBoxes = 0, gUnits = 0;
        const first = boxes[i];
        while (i < boxes.length && boxes[i].store === groupKey) {
          const b = boxes[i];
          if (y < MG + 30) { ({ page: pg, y } = header()); }
          if (shade) pg.drawRectangle({ x: MG, y: y - 3.5, width: usableW, height: ROW, color: rgb(0.955, 0.962, 0.972) });
          cell(pg, 0, b.soc || "SEM SOC", y, mbS, 10, b.soc ? rgb(0, 0, 0) : rgb(0.75, 0.1, 0.1));
          cell(pg, 1, b.store || "-", y, mS, 9);
          cell(pg, 2, b.storeName || "-", y, fS, 9);
          cell(pg, 3, (b.lg || "-").replace(/^LG/i, ""), y, mS, 9);
          cell(pg, 4, b.ean || "-", y, mS, 9);
          cell(pg, 5, b.description || "-", y, fS, 9);
          cell(pg, 6, String(Math.round(b.qty)), y, mbS, 10);
          // quadrado para marcar na conferência
          const bx = colX[7] + colW[7] / 2 - 4.5;
          pg.drawRectangle({ x: bx, y: y - 2, width: 9, height: 9, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 0.8 });
          y -= ROW;
          gBoxes++; gUnits += b.qty;
          i++;
        }
        totalUnits += gUnits;
        // Sem subtotal por loja (pedido do utilizador): só a mudança de fundo separa as lojas.
        shade = !shade;
      }
      y -= 4;
      if (y < MG + 30) { ({ page: pg, y } = header()); }
      pg.drawRectangle({ x: MG, y: y - 4, width: usableW, height: 16, color: rgb(0.88, 0.93, 0.98) });
      pg.drawText(`TOTAL: ${boxes.length} caixas`, { x: colX[2] + 3, y, size: 9.5, font: bS });
      cell(pg, 6, String(Math.round(totalUnits)), y, mbS, 10);

      const totalPagesS = pagesS.length;
      pagesS.forEach((p, idx) => {
        p.drawText(fit(fS, `Gerado em ${genS} por ${sanitize(userLabel)} - Pagina ${idx + 1} de ${totalPagesS}`, 8, usableW), { x: MG, y: 14, size: 8, font: fS, color: rgb(0.45, 0.45, 0.45) });
      });

      const bytesS = await pdfS.save();
      const pathS = `${order_id}/lista_caixas_soc_${order.order_number}_${Date.now()}.pdf`;
      const { error: upS } = await supabase.storage.from("exports").upload(pathS, bytesS, { contentType: "application/pdf", upsert: true });
      if (upS) throw new Error(`Falha ao carregar PDF: ${upS.message}`);
      const { data: signedS, error: urlS } = await supabase.storage.from("exports").createSignedUrl(pathS, 3600);
      if (urlS) throw new Error(`Falha ao gerar URL: ${urlS.message}`);
      return new Response(JSON.stringify({
        success: true,
        mode: "soc",
        pdf_url: signedS.signedUrl,
        storage_path: pathS,
        filename: `lista_caixas_soc_${order.order_number}.pdf`,
        pages: totalPagesS,
        totals: { boxes: boxes.length, units: totalUnits },
        warnings,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Group by LG ──
    const byLg = new Map<string, Row[]>();
    for (const r of rows) {
      const k = r.lg_code || "-";
      if (!byLg.has(k)) byLg.set(k, []);
      byLg.get(k)!.push(r);
    }
    const lgKeys = Array.from(byLg.keys()).sort((a, b) => {
      const an = parseInt(a.replace(/^LG/i, ""), 10) || 0;
      const bn = parseInt(b.replace(/^LG/i, ""), 10) || 0;
      return an - bn;
    });

    // ── SINGLE PAGE MODE ──
    if (sheetMode === "single_page") {
      const nowSp = new Date();
      const genAt = `${String(nowSp.getDate()).padStart(2, "0")}/${String(nowSp.getMonth() + 1).padStart(2, "0")}/${nowSp.getFullYear()} ${String(nowSp.getHours()).padStart(2, "0")}:${String(nowSp.getMinutes()).padStart(2, "0")}`;
      const spWarnings = [...warnings];

      // LG DESC, store ASC, line ASC
      const lgDesc = Array.from(byLg.keys()).sort((a, b) => {
        const an = parseInt(a.replace(/^LG/i, ""), 10) || 0;
        const bn = parseInt(b.replace(/^LG/i, ""), 10) || 0;
        return bn - an;
      });
      const ordered: Array<{ type: "row"; row: Row } | { type: "sub"; text: string }> = [];
      const groupIndex = new Map<string, number>();
      let gi = 0;
      let tBoxes = 0, tUnits = 0;
      const allStores = new Set<string>();
      for (const lg of lgDesc) {
        const g = byLg.get(lg)!.slice().sort((a, b) => {
          const an = parseInt(a.store_code, 10), bn = parseInt(b.store_code, 10);
          if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
          if (a.store_code !== b.store_code) return a.store_code.localeCompare(b.store_code);
          return a.line_number - b.line_number;
        });
        groupIndex.set(lg, gi++);
        const stores = new Set(g.map((r) => r.store_code));
        let gB = 0, gU = 0;
        for (const r of g) {
          ordered.push({ type: "row", row: r });
          gB += r.boxes; gU += r.units;
          allStores.add(`${lg}|${r.store_code}`);
        }
        tBoxes += gB; tUnits += gU;
        ordered.push({ type: "sub", text: `LG ${lg.replace(/^LG/i, "")}: ${stores.size} loja(s) - ${Math.round(gB)} cx - ${Math.round(gU)} UN` });
      }

      const pdfSp = await PDFDocument.create();
      const fSp = await pdfSp.embedFont(StandardFonts.Helvetica);
      const bSp = await pdfSp.embedFont(StandardFonts.HelveticaBold);
      const mSp = await pdfSp.embedFont(StandardFonts.Courier);
      const PW = A4_H, PH = A4_W; // landscape
      const MG = 28; // ~10mm
      const headerH = 46, footerH = 18;

      // pick font size
      const rowH = (s: number) => s + 3;
      const nSubs = ordered.filter((e) => e.type === "sub").length;
      const nRows = ordered.length - nSubs;
      const avail = (s: number) => (PH - MG - headerH - rowH(s) - 4) - (MG + footerH + rowH(s));
      const needed = (s: number) => nRows * rowH(s) + nSubs * (rowH(s) + 2);
      let size = 8;
      while (size > 6.5 && needed(size) > avail(size)) size -= 0.25;
      if (needed(size) > avail(size)) spWarnings.push("Conteúdo excedeu uma página.");

      const usableW = PW - MG * 2;
      const widths = [0.06, 0.07, 0.19, 0.13, 0.31, 0.07, 0.07, 0.10].map((p) => p * usableW);
      const labels = ["LG", "Cód. Loja", "Nome da Loja", "Artigo (EAN)", "Descrição", "Qtd/Cx", "Caixas", "Total UN"];
      const aligns: Array<"left" | "right"> = ["left", "left", "left", "left", "left", "right", "right", "right"];
      const xs: number[] = [];
      let acc = MG;
      for (const w of widths) { xs.push(acc); acc += w; }

      const drawSp = (page: PDFPage, col: number, text: string, y: number, f: PDFFont, s: number) => {
        const t = fit(f, text, s, widths[col] - 4);
        const x = aligns[col] === "right" ? xs[col] + widths[col] - 2 - f.widthOfTextAtSize(t, s) : xs[col] + 2;
        page.drawText(t, { x, y, size: s, font: f, color: rgb(0.1, 0.1, 0.1) });
      };

      const spPages: PDFPage[] = [];
      const startPage = () => {
        const page = pdfSp.addPage([PW, PH]);
        spPages.push(page);
        let y = PH - MG - 10;
        page.drawText(fit(bSp, `MAPA DE CONFERENCIA - Encomenda ${sanitize(String(order.order_number || "-"))} - ${sanitize(String(order.customer_name || "-"))}`, 12, usableW), { x: MG, y, size: 12, font: bSp });
        y -= 14;
        page.drawText(fit(fSp, `Armazem ${orderWarehouse || "-"} | Entrega: ${order.delivery_date ? fmtDate(order.delivery_date) : "-"} | Guia: ${order.transport_guide || "-"}`, 9, usableW), { x: MG, y, size: 9, font: fSp, color: rgb(0.25, 0.25, 0.25) });
        y -= 16;
        page.drawRectangle({ x: MG, y: y - 4, width: usableW, height: 13, color: rgb(0.88, 0.9, 0.94) });
        for (let c = 0; c < labels.length; c++) drawSp(page, c, labels[c], y, bSp, Math.max(size, 7));
        y -= rowH(size) + 4;
        return { page, y };
      };

      let cur = startPage();
      let pageRef = cur.page;
      let yy = cur.y;
      for (const entry of ordered) {
        if (yy < MG + footerH + rowH(size)) {
          cur = startPage(); pageRef = cur.page; yy = cur.y;
        }
        if (entry.type === "sub") {
          pageRef.drawLine({ start: { x: MG, y: yy + rowH(size) - 2 }, end: { x: PW - MG, y: yy + rowH(size) - 2 }, thickness: 1.1, color: rgb(0.5, 0.55, 0.62) });
          pageRef.drawText(fit(bSp, entry.text, size, usableW), { x: MG + 2, y: yy, size, font: bSp, color: rgb(0, 0.25, 0.55) });
          yy -= rowH(size) + 2;
          continue;
        }
        const r = entry.row;
        const idx = groupIndex.get(r.lg_code || "-") ?? 0;
        if (idx % 2 === 1) {
          pageRef.drawRectangle({ x: MG, y: yy - 2.5, width: usableW, height: rowH(size), color: rgb(0.955, 0.962, 0.972) });
        }
        drawSp(pageRef, 0, (r.lg_code || "-").replace(/^LG/i, ""), yy, mSp, size);
        drawSp(pageRef, 1, r.store_code || "-", yy, mSp, size);
        drawSp(pageRef, 2, r.store_name || "-", yy, fSp, size);
        drawSp(pageRef, 3, r.ean || "-", yy, mSp, size);
        drawSp(pageRef, 4, r.description || "-", yy, fSp, size);
        drawSp(pageRef, 5, r.per_box != null ? String(Math.round(r.per_box)) : "-", yy, mSp, size);
        drawSp(pageRef, 6, String(Math.round(r.boxes)), yy, mSp, size);
        drawSp(pageRef, 7, String(Math.round(r.units)), yy, mSp, size);
        yy -= rowH(size);
      }

      const footer = `Totais: ${lgDesc.length} LGs - ${allStores.size} lojas - ${Math.round(tBoxes)} caixas - ${Math.round(tUnits)} UN | Gerado em ${genAt} por ${sanitize(userLabel)}`;
      spPages.forEach((p) => {
        p.drawLine({ start: { x: MG, y: MG + 12 }, end: { x: PW - MG, y: MG + 12 }, thickness: 0.6, color: rgb(0.7, 0.7, 0.7) });
        p.drawText(fit(bSp, footer, 8, usableW), { x: MG, y: MG, size: 8, font: bSp, color: rgb(0.2, 0.2, 0.2) });
      });

      const spBytes = await pdfSp.save();
      const spPath = `${order_id}/conferencia_1pagina_${order.order_number}_${Date.now()}.pdf`;
      const { error: spUpErr } = await supabase.storage
        .from("exports").upload(spPath, spBytes, { contentType: "application/pdf", upsert: true });
      if (spUpErr) throw new Error(`Falha ao carregar PDF: ${spUpErr.message}`);
      const { data: spSigned, error: spUrlErr } = await supabase.storage
        .from("exports").createSignedUrl(spPath, 3600);
      if (spUrlErr) throw new Error(`Falha ao gerar URL: ${spUrlErr.message}`);

      return new Response(JSON.stringify({
        success: true,
        mode: "single_page",
        pdf_url: spSigned.signedUrl,
        storage_path: spPath,
        filename: `conferencia_1pagina_${order.order_number}.pdf`,
        pages: spPages.length,
        rows: rows.length,
        totals: { lgs: lgDesc.length, stores: allStores.size, boxes: tBoxes, units: tUnits },
        warnings: spWarnings,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── PDF ──
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const mono = await pdf.embedFont(StandardFonts.Courier);
    const monoBold = await pdf.embedFont(StandardFonts.CourierBold);

    const COLS = [
      { key: "ean", label: "Artigo (EAN)", x: M, w: 92, align: "left" },
      { key: "desc", label: "Descrição", x: M + 92, w: 150, align: "left" },
      { key: "store", label: "Cód. Loja", x: M + 242, w: 52, align: "left" },
      { key: "name", label: "Nome da Loja", x: M + 294, w: 120, align: "left" },
      { key: "perbox", label: "Qtd/Cx", x: M + 414, w: 40, align: "right" },
      { key: "boxes", label: "Caixas", x: M + 454, w: 40, align: "right" },
      { key: "units", label: "Total UN", x: M + 494, w: 50, align: "right" },
    ] as const;

    const pages: PDFPage[] = [];
    const totalsPerLg: Array<{ lg: string; stores: number; boxes: number; units: number }> = [];
    const now = new Date();
    const generatedAt = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const drawCell = (page: PDFPage, col: typeof COLS[number], text: string, y: number, f: PDFFont, size: number) => {
      const t = fit(f, text, size, col.w - 6);
      const x = col.align === "right" ? col.x + col.w - 3 - f.widthOfTextAtSize(t, size) : col.x + 3;
      page.drawText(t, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    };

    const newPage = (lgLabel: string) => {
      const page = pdf.addPage([A4_W, A4_H]);
      pages.push(page);
      let y = A4_H - M;
      page.drawText("MAPA DE CONFERENCIA DE EXPEDICAO", { x: M, y: y - 12, size: 14, font: bold });
      y -= 30;
      const info = [
        `Encomenda: ${sanitize(String(order.order_number || "-"))}    Cliente: ${sanitize(String(order.customer_name || "-"))}`,
        `Armazem: ${orderWarehouse || "-"}    Guia de Transporte: ${order.transport_guide || "-"}`,
        `Data de entrega: ${order.delivery_date ? fmtDate(order.delivery_date) : "-"}`,
      ];
      for (const linetxt of info) {
        page.drawText(fit(font, linetxt, 9, A4_W - 2 * M), { x: M, y, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
        y -= 13;
      }
      y -= 6;
      page.drawText(`LG ${sanitize(lgLabel.replace(/^LG/i, ""))}`, { x: M, y: y - 12, size: 20, font: bold, color: rgb(0, 0.25, 0.55) });
      y -= 30;
      // header row
      page.drawRectangle({ x: M, y: y - 4, width: A4_W - 2 * M, height: 16, color: rgb(0.9, 0.92, 0.95) });
      for (const c of COLS) drawCell(page, c, c.label, y, bold, 8.5);
      y -= 18;
      return { page, y };
    };

    let pageCursor = { page: null as PDFPage | null, y: 0 };

    for (const lg of lgKeys) {
      const lgRows = byLg.get(lg)!;
      lgRows.sort((a, b) => {
        const an = parseInt(a.store_code, 10);
        const bn = parseInt(b.store_code, 10);
        if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
        if (a.store_code !== b.store_code) return a.store_code.localeCompare(b.store_code);
        return a.line_number - b.line_number;
      });

      let cur = newPage(lg);
      let y = cur.y;
      let page = cur.page;

      let lgBoxes = 0, lgUnits = 0;
      const storeSet = new Set<string>();
      let i = 0;
      while (i < lgRows.length) {
        const store = lgRows[i].store_code;
        storeSet.add(store);
        let sBoxes = 0, sUnits = 0;
        while (i < lgRows.length && lgRows[i].store_code === store) {
          const r = lgRows[i];
          if (y < M + 60) {
            cur = newPage(lg);
            page = cur.page;
            y = cur.y;
          }
          drawCell(page, COLS[0], r.ean || "-", y, mono, 9);
          drawCell(page, COLS[1], r.description || "-", y, font, 9);
          drawCell(page, COLS[2], r.store_code || "-", y, mono, 9);
          drawCell(page, COLS[3], r.store_name, y, font, 9);
          drawCell(page, COLS[4], r.per_box != null ? String(Math.round(r.per_box)) : "-", y, mono, 9);
          drawCell(page, COLS[5], String(Math.round(r.boxes)), y, mono, 9);
          drawCell(page, COLS[6], String(Math.round(r.units)), y, mono, 9);
          y -= 14;
          sBoxes += r.boxes;
          sUnits += r.units;
          i++;
        }
        if (y < M + 60) { cur = newPage(lg); page = cur.page; y = cur.y; }
        page.drawLine({ start: { x: M, y: y + 10 }, end: { x: A4_W - M, y: y + 10 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
        drawCell(page, COLS[3], `Subtotal loja ${store}`, y, bold, 9);
        drawCell(page, COLS[5], String(Math.round(sBoxes)), y, monoBold, 9);
        drawCell(page, COLS[6], String(Math.round(sUnits)), y, monoBold, 9);
        y -= 20;
        lgBoxes += sBoxes;
        lgUnits += sUnits;
      }

      if (y < M + 50) { cur = newPage(lg); page = cur.page; y = cur.y; }
      page.drawRectangle({ x: M, y: y - 4, width: A4_W - 2 * M, height: 16, color: rgb(0.88, 0.93, 0.98) });
      drawCell(page, COLS[3], `TOTAL LG ${lg.replace(/^LG/i, "")}`, y, bold, 9.5);
      drawCell(page, COLS[5], String(Math.round(lgBoxes)), y, monoBold, 9.5);
      drawCell(page, COLS[6], String(Math.round(lgUnits)), y, monoBold, 9.5);

      totalsPerLg.push({ lg, stores: storeSet.size, boxes: lgBoxes, units: lgUnits });
    }

    // ── Summary page ──
    {
      const page = pdf.addPage([A4_W, A4_H]);
      pages.push(page);
      let y = A4_H - M - 12;
      page.drawText("RESUMO GERAL", { x: M, y, size: 16, font: bold });
      y -= 24;
      page.drawText(fit(font, `Encomenda: ${sanitize(String(order.order_number || "-"))}`, 10, A4_W - 2 * M), { x: M, y, size: 10, font });
      y -= 24;

      const SC = [
        { x: M, w: 100, label: "LG", align: "left" },
        { x: M + 100, w: 100, label: "Nº Lojas", align: "right" },
        { x: M + 200, w: 110, label: "Total Caixas", align: "right" },
        { x: M + 310, w: 110, label: "Total UN", align: "right" },
      ] as const;
      page.drawRectangle({ x: M, y: y - 4, width: 420, height: 16, color: rgb(0.9, 0.92, 0.95) });
      for (const c of SC) drawCell(page, c as unknown as typeof COLS[number], c.label, y, bold, 9);
      y -= 18;

      let tB = 0, tU = 0, tS = 0;
      for (const t of totalsPerLg) {
        drawCell(page, SC[0] as unknown as typeof COLS[number], `LG ${t.lg.replace(/^LG/i, "")}`, y, mono, 9);
        drawCell(page, SC[1] as unknown as typeof COLS[number], String(t.stores), y, mono, 9);
        drawCell(page, SC[2] as unknown as typeof COLS[number], String(Math.round(t.boxes)), y, mono, 9);
        drawCell(page, SC[3] as unknown as typeof COLS[number], String(Math.round(t.units)), y, mono, 9);
        y -= 14;
        tB += t.boxes; tU += t.units; tS += t.stores;
      }
      y -= 4;
      page.drawRectangle({ x: M, y: y - 4, width: 420, height: 16, color: rgb(0.88, 0.93, 0.98) });
      drawCell(page, SC[0] as unknown as typeof COLS[number], "TOTAL", y, bold, 9.5);
      drawCell(page, SC[1] as unknown as typeof COLS[number], String(tS), y, monoBold, 9.5);
      drawCell(page, SC[2] as unknown as typeof COLS[number], String(Math.round(tB)), y, monoBold, 9.5);
      drawCell(page, SC[3] as unknown as typeof COLS[number], String(Math.round(tU)), y, monoBold, 9.5);
    }

    // ── Footers ──
    const totalPages = pages.length;
    pages.forEach((p, idx) => {
      const txt = fit(font, `Gerado em ${generatedAt} por ${sanitize(userLabel)} — Pagina ${idx + 1} de ${totalPages}`.replace("—", "-"), 8, A4_W - 2 * M);
      p.drawText(txt, { x: M, y: 20, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
    });

    const bytes = await pdf.save();
    const storagePath = `${order_id}/conferencia_${order.order_number}_${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from("exports").upload(storagePath, bytes, { contentType: "application/pdf", upsert: true });
    if (upErr) throw new Error(`Falha ao carregar PDF: ${upErr.message}`);

    const { data: signed, error: urlErr } = await supabase.storage
      .from("exports").createSignedUrl(storagePath, 3600);
    if (urlErr) throw new Error(`Falha ao gerar URL: ${urlErr.message}`);

    const totals = {
      lgs: totalsPerLg.length,
      stores: totalsPerLg.reduce((s, t) => s + t.stores, 0),
      boxes: totalsPerLg.reduce((s, t) => s + t.boxes, 0),
      units: totalsPerLg.reduce((s, t) => s + t.units, 0),
    };

    return new Response(JSON.stringify({
      success: true,
      pdf_url: signed.signedUrl,
      storage_path: storagePath,
      filename: `conferencia_${order.order_number}.pdf`,
      pages: totalPages,
      totals,
      warnings,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Error in generate-picking-sheet:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
