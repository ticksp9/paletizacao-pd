import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireRole } from "../_shared/requireRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Configuração ──────────────────────────────────────────────
const MAX_PHYSICAL_HEIGHT_MM = 1800;
const PALLET_BASE_HEIGHT_MM = 150;
const DEFAULT_BOX_MM = { l: 400, w: 300, h: 300 };
const MIXED_MAX_BOXES_PER_LG = 5; // regra das 5 caixas
const SUPPORT_RATIO = 0.9; // apoio mínimo por baixo de cada caixa (loiça: quase total)
const LAYER_TOLERANCE_MM = 20; // diferença máxima de altura entre caixas da mesma camada
const LG_PRIORITY_MIN_COVERAGE = 0.9; // camadas aceites para a regra dos LG: ≥90% da melhor cobertura
const MIN_STACK_COVERAGE = 0.7; // só se empilha sobre camadas que cubram 70% da base (sem degraus nem torres)
const MIN_COMPACTNESS = 0.93; // caixas encostadas: espaço vazio só na borda, nunca no meio
const PALLET_HEIGHT_LIMIT_MM: Record<string, number> = {
  "120x80": 1800,
  "60x80": 1250,
};
const PALLET_WEIGHT_LIMIT_KG: Record<string, number> = {
  "120x80": 1000,
  "60x80": 500,
  "120x100": 1000,
};
// The exceptional 60x40 size is not offered for manual correction.

interface PalletSize {
  name: string;
  length: number; // mm (C)
  width: number; // mm (L)
}

// Da mais pequena para a maior (para escolher a mínima suficiente).
// 60x40 é uma palete de 1/4 excecional e não é escolhida automaticamente.
const PALLET_SIZES: PalletSize[] = [
  { name: "60x80", length: 800, width: 600 },
  { name: "120x80", length: 1200, width: 800 },
  { name: "120x100", length: 1200, width: 1000 },
];
const EURO_PALLET = PALLET_SIZES[1];
const LARGER_JM_PALLET = PALLET_SIZES[2];

function maxTotalHeight(size: PalletSize): number {
  return PALLET_HEIGHT_LIMIT_MM[size.name] ?? MAX_PHYSICAL_HEIGHT_MM;
}

function usableHeight(size: PalletSize): number {
  return maxTotalHeight(size) - PALLET_BASE_HEIGHT_MM;
}

interface OrderLineRow {
  id: string;
  line_number: number;
  article_code: string;
  article_description: string | null;
  quantity: number;
  lg_code: string | null;
  store_code: string | null;
  quantity_cases: number | null;
}

interface BoxSpec {
  l: number;
  w: number;
  h: number;
  pieces_per_box: number;
  estimated: boolean;
  weight_kg: number | null;
}

interface WorkItem {
  order_line_id: string;
  line_number: number;
  article_code: string;
  description: string | null;
  lg_code: string | null;
  lg_num: number;
  store_code: string | null;
  boxes: number;
  spec: BoxSpec;
}

interface PlacedBox {
  order_line_id: string;
  line_number: number;
  article_code: string;
  lg_code: string | null;
  store_code: string | null;
  layer: number;
  placement_sequence: number;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  box_l: number;
  box_w: number;
  box_h: number;
  weight_kg: number | null;
  orientation: string;
  rotated: boolean;
  pieces: number;
}

interface PalletResult {
  size: PalletSize;
  boxes: PlacedBox[];
  height_mm: number;
  layers: number;
  warnings: string[];
  base_usage_pct: number;
  /** Palete completa definida pelo administrador: 1 SOC e 1 etiqueta. */
  single_label?: boolean;
}

interface FullPalletRow {
  position: number;
  store_code: string;
  lines: Array<{ order_line_id: string; boxes: number }>;
}

type PalletSizeName = "120x80" | "60x80" | "120x100";
type PlanSelection = "keep" | "split";
type PlanEdit =
  | { type: "move_store"; from_pallet: number; to_pallet: number | null; store_code: string }
  | { type: "resize_pallet"; pallet_number: number; size: PalletSizeName };

function lgNumeric(lg: string | null): number {
  if (!lg) return -1;
  const m = lg.match(/\d+/);
  return m ? parseInt(m[0], 10) : -1;
}

function parseDims(raw: string | null): { l: number; w: number; h: number } | null {
  if (!raw) return null;
  const nums = raw.match(/\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length < 3) return null;
  const v = nums.slice(0, 3).map((n) => parseFloat(n.replace(",", ".")));
  if (v.some((n) => !isFinite(n) || n <= 0)) return null;
  return { l: Math.round(v[0]), w: Math.round(v[1]), h: Math.round(v[2]) };
}

// ── Rotação livre: as 6 orientações possíveis ────────────────
interface Orient {
  l: number;
  w: number;
  h: number;
  label: string;
}

function orientations(spec: BoxSpec): Orient[] {
  const { l, w, h } = spec;
  const all: Orient[] = [
    { l, w, h, label: "CxLxA" },
    { l, w: h, h: w, label: "CxAxL" },
    { l: w, w: l, h, label: "LxCxA" },
    { l: w, w: h, h: l, label: "LxAxC" },
    { l: h, w: l, h: w, label: "AxCxL" },
    { l: h, w, h: l, label: "AxLxC" },
  ];
  const seen = new Set<string>();
  const out: Orient[] = [];
  for (const o of all) {
    const key = `${o.l}x${o.w}x${o.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  // preferir orientações mais baixas (empilhar plano) e, em empate, maior base
  out.sort((a, b) => (a.h !== b.h ? a.h - b.h : b.l * b.w - a.l * a.w));
  return out;
}

function fitsAnywhere(spec: BoxSpec, size: PalletSize): boolean {
  const weightLimit = PALLET_WEIGHT_LIMIT_KG[size.name];
  return orientations(spec).some(
    (o) =>
      o.l <= size.length &&
      o.w <= size.width &&
      o.h <= usableHeight(size) &&
      (weightLimit === undefined || spec.weight_kg === null || spec.weight_kg <= weightLimit),
  );
}

// ── Montagem por camadas planas ───────────────────────────────
// Loiça é frágil: no camião nada pode bater. A palete é montada em camadas completas e
// niveladas, com as caixas encostadas umas às outras.
//  * Cada camada usa caixas da mesma altura (diferença até LAYER_TOLERANCE_MM): o topo fica plano.
//  * As caixas são encostadas a partir de um canto (em filas ou em colunas). O espaço que
//    sobra fica junto à borda, nunca no meio (MIN_COMPACTNESS).
//  * Cada caixa tem apoio quase total por baixo (SUPPORT_RATIO).
//  * Só se empilha sobre camadas quase completas (MIN_STACK_COVERAGE): não há degraus nem torres.
//    A camada de cima pode ser incompleta; o resto vai para outra palete.
//  * Duas caixas baixas podem ir uma em cima da outra (a de cima mais pequena, bem apoiada)
//    para a coluna ficar à altura da camada, por exemplo 130 + 150 ao lado de caixas de 290.
//  * Entre as camadas possíveis fica a que dá prioridade ao LG mais alto (regra dos LG).
//  * A ordem de colocação dentro da camada segue a regra do caracol (à volta, de fora para dentro).
//  * As caixas podem rodar (qualquer face para baixo), sempre dentro da palete.

interface Rect {
  x: number;
  y: number;
  l: number;
  w: number;
  h: number;
  top: number;
}

interface LayerPlacement {
  item: WorkItem;
  x: number;
  y: number;
  o: Orient;
  /** Altura a que a caixa assenta dentro da camada (caixa de cima de uma coluna de duas). */
  dz?: number;
}

interface LayerFill {
  placements: LayerPlacement[];
  /** Área coberta por caixas com a altura da camada (as que servem de apoio). */
  fullArea: number;
  height: number;
  weightKg: number;
}

/**
 * Regra do caracol (como os operadores montam): em cada camada as caixas vão à volta da
 * palete no sentido dos ponteiros do relógio, a começar no canto da frente à esquerda,
 * primeiro o anel de fora e depois para dentro. Devolve a ordem de preferência do ponto.
 */
function clockwiseSpiralRank(
  size: PalletSize,
  point: { x: number; y: number },
  orientation: Orient,
): [number, number, number, number] {
  const right = size.length - (point.x + orientation.l);
  const back = size.width - (point.y + orientation.w);
  const ring = Math.min(point.x, point.y, right, back);
  const ringLength = size.length - 2 * ring;
  const ringWidth = size.width - 2 * ring;
  let distance: number;

  if (point.y === ring) {
    distance = point.x - ring;
  } else if (right === ring) {
    distance = ringLength + point.y - ring;
  } else if (back === ring) {
    distance = ringLength + ringWidth + size.length - ring - (point.x + orientation.l);
  } else {
    distance = 2 * ringLength + ringWidth + size.width - ring - (point.y + orientation.w);
  }

  return [ring, distance, point.y, point.x];
}

function compareRank(a: [number, number, number, number], b: [number, number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

function overlapArea(ax: number, ay: number, al: number, aw: number, b: Rect): number {
  const ox = Math.max(0, Math.min(ax + al, b.x + b.l) - Math.max(ax, b.x));
  const oy = Math.max(0, Math.min(ay + aw, b.y + b.w) - Math.max(ay, b.y));
  return ox * oy;
}

/**
 * Enche uma camada à altura z com caixas cuja altura fica entre minH e maxH.
 * `below` = caixas da camada de baixo (para o apoio); `existing` = caixas já nesta camada.
 */
function fillLayer(
  size: PalletSize,
  items: WorkItem[],
  remaining: Map<WorkItem, number>,
  z: number,
  minH: number,
  maxH: number,
  below: Rect[],
  existing: Rect[],
  weightBudgetKg: number,
  rotatedFirst: boolean,
  columns = false,
  withPairs = false,
): LayerFill {
  const rects: Rect[] = [...existing];
  const placements: LayerPlacement[] = [];
  let points: Array<{ x: number; y: number }> = existing.length === 0
    ? [{ x: 0, y: 0 }]
    : [{ x: 0, y: 0 }, ...existing.flatMap((r) => [{ x: r.x + r.l, y: r.y }, { x: r.x, y: r.y + r.w }])];
  let fullArea = 0;
  let height = 0;
  let weightKg = 0;
  const left = new Map(remaining);

  for (const item of items) {
    let count = left.get(item) ?? 0;
    if (count <= 0) continue;
    const opts = orientations(item.spec)
      .filter((o) => o.h >= minH && o.h <= maxH && z + o.h <= usableHeight(size) &&
        o.l <= size.length && o.w <= size.width)
      .sort((a, b) =>
        b.h - a.h ||
        (rotatedFirst ? Number(a.l >= a.w) - Number(b.l >= b.w) : Number(b.l >= b.w) - Number(a.l >= a.w))
      );
    if (opts.length === 0) continue;
    const boxWeight = item.spec.weight_kg ?? 0;

    while (count > 0) {
      if (weightKg + boxWeight > weightBudgetKg) break;
      // Encostar a partir do canto: em filas (frente para trás) ou em colunas (esquerda para
      // a direita). As caixas do mesmo artigo são postas seguidas, por isso ficam juntas.
      let chosen: { x: number; y: number; o: Orient; rank: [number, number, number, number] } | null = null;
      for (const p of points) {
        for (const o of opts) {
          if (p.x + o.l > size.length || p.y + o.w > size.width) continue;
          const rank: [number, number, number, number] = columns ? [p.x, p.y, 0, 0] : [p.y, p.x, 0, 0];
          if (chosen && compareRank(rank, chosen.rank) >= 0) continue;
          if (rects.some((r) => overlapArea(p.x, p.y, o.l, o.w, r) > 0)) continue;
          if (z > 0) {
            const support = below.reduce((sum, r) => sum + overlapArea(p.x, p.y, o.l, o.w, r), 0);
            if (support < o.l * o.w * SUPPORT_RATIO) continue;
          }
          chosen = { x: p.x, y: p.y, o, rank };
        }
      }
      if (!chosen) break;
      const { x, y, o } = chosen;
      rects.push({ x, y, l: o.l, w: o.w, h: o.h, top: z + o.h });
      placements.push({ item, x, y, o });
      points = points.filter((p) => !(p.x === x && p.y === y));
      for (const c of [{ x: x + o.l, y }, { x, y: y + o.w }]) {
        if (c.x < size.length && c.y < size.width && !points.some((p) => p.x === c.x && p.y === c.y)) {
          points.push(c);
        }
      }
      if (o.h >= maxH - LAYER_TOLERANCE_MM) fullArea += o.l * o.w;
      height = Math.max(height, o.h);
      weightKg += boxWeight;
      count -= 1;
    }
    left.set(item, count);
  }

  // Colunas de duas caixas baixas (a de cima com a base dentro da de baixo) que juntas
  // ficam com a altura da camada.
  const pairOptions: Array<{ a: WorkItem; oa: Orient; b: WorkItem; ob: Orient }> = [];
  const seenPairs = new Set<string>();
  for (const a of withPairs ? items : []) {
    if ((left.get(a) ?? 0) <= 0) continue;
    for (const oa of orientations(a.spec)) {
      if (oa.h >= minH || oa.l > size.length || oa.w > size.width) continue;
      for (const b of items) {
        if ((left.get(b) ?? 0) <= (b === a ? 1 : 0)) continue;
        for (const ob of orientations(b.spec)) {
          const total = oa.h + ob.h;
          if (total < minH || total > maxH || z + total > usableHeight(size)) continue;
          if (ob.l > oa.l || ob.w > oa.w) continue;
          const key = `${items.indexOf(a)}:${oa.label}:${items.indexOf(b)}:${ob.label}`;
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          pairOptions.push({ a, oa, b, ob });
        }
      }
    }
  }
  // Primeiro as colunas que cobrem mais base e cuja caixa de cima tapa melhor a de baixo.
  pairOptions.sort((p1, p2) =>
    p2.ob.l * p2.ob.w - p1.ob.l * p1.ob.w || p2.oa.l * p2.oa.w - p1.oa.l * p1.oa.w
  );
  for (let guard = 0; guard < 200 && pairOptions.length > 0; guard++) {
    let chosen: { x: number; y: number; a: WorkItem; oa: Orient; b: WorkItem; ob: Orient; rank: number[] } | null = null;
    for (const { a, oa, b, ob } of pairOptions) {
      if ((left.get(a) ?? 0) <= 0 || (left.get(b) ?? 0) <= (b === a ? 1 : 0)) continue;
      const pairWeight = (a.spec.weight_kg ?? 0) + (b.spec.weight_kg ?? 0);
      if (weightKg + pairWeight > weightBudgetKg) continue;
      for (const p of points) {
        if (p.x + oa.l > size.length || p.y + oa.w > size.width) continue;
        const rank = columns ? [p.x, p.y] : [p.y, p.x];
        if (chosen && (rank[0] > chosen.rank[0] || (rank[0] === chosen.rank[0] && rank[1] >= chosen.rank[1]))) continue;
        if (rects.some((r) => overlapArea(p.x, p.y, oa.l, oa.w, r) > 0)) continue;
        if (z > 0) {
          const support = below.reduce((sum, r) => sum + overlapArea(p.x, p.y, oa.l, oa.w, r), 0);
          if (support < oa.l * oa.w * SUPPORT_RATIO) continue;
        }
        chosen = { x: p.x, y: p.y, a, oa, b, ob, rank };
      }
      if (chosen) break; // a melhor coluna que cabe; a posição é a mais encostada ao canto
    }
    if (!chosen) break;
    const { x, y, a, oa, b, ob } = chosen;
    const total = oa.h + ob.h;
    rects.push({ x, y, l: oa.l, w: oa.w, h: total, top: z + total });
    placements.push({ item: a, x, y, o: oa, dz: 0 });
    placements.push({ item: b, x, y, o: ob, dz: oa.h });
    left.set(a, (left.get(a) ?? 0) - 1);
    left.set(b, (left.get(b) ?? 0) - 1);
    points = points.filter((q) => !(q.x === x && q.y === y));
    for (const c of [{ x: x + oa.l, y }, { x, y: y + oa.w }]) {
      if (c.x < size.length && c.y < size.width && !points.some((q) => q.x === c.x && q.y === c.y)) {
        points.push(c);
      }
    }
    fullArea += ob.l * ob.w;
    height = Math.max(height, total);
    weightKg += (a.spec.weight_kg ?? 0) + (b.spec.weight_kg ?? 0);
  }
  return { placements, fullArea, height, weightKg };
}

/** Área coberta / área do retângulo que envolve as caixas (1 = sem buracos no meio). */
function compactness(all: LayerPlacement[]): number {
  const placements = all.filter((p) => !p.dz);
  if (placements.length === 0) return 0;
  const minX = Math.min(...placements.map((p) => p.x));
  const minY = Math.min(...placements.map((p) => p.y));
  const maxX = Math.max(...placements.map((p) => p.x + p.o.l));
  const maxY = Math.max(...placements.map((p) => p.y + p.o.w));
  const area = placements.reduce((sum, p) => sum + p.o.l * p.o.w, 0);
  return area / ((maxX - minX) * (maxY - minY));
}

interface StackedPlacement extends LayerPlacement {
  z: number;
}

/**
 * Camada de cima: põe caixas baixas por cima de outras caixas baixas da mesma camada,
 * para que a coluna fique à altura da camada (nunca mais alta).
 */
function stackLowBoxes(
  size: PalletSize,
  items: WorkItem[],
  left: Map<WorkItem, number>,
  layer: StackedPlacement[],
  layerTop: number,
  weightBudgetKg: number,
): { placements: StackedPlacement[]; weightKg: number } {
  const added: StackedPlacement[] = [];
  let weightKg = 0;
  let placed = true;
  while (placed) {
    placed = false;
    const all = [...layer, ...added];
    // Superfícies baixas onde ainda cabe uma caixa por cima.
    const bases = all
      .map((p) => ({ p, top: p.z + p.o.h }))
      .filter(({ top }) => top < layerTop - LAYER_TOLERANCE_MM);
    for (const item of items) {
      if ((left.get(item) ?? 0) <= 0) continue;
      const boxWeight = item.spec.weight_kg ?? 0;
      if (weightKg + boxWeight > weightBudgetKg) continue;
      for (const { p: base, top } of bases) {
        for (const o of orientations(item.spec)) {
          if (top + o.h > layerTop || top + o.h < layerTop - LAYER_TOLERANCE_MM) continue;
          const x = base.x;
          const y = base.y;
          if (x + o.l > size.length || y + o.w > size.width) continue;
          const collides = all.some((q) =>
            x < q.x + q.o.l && x + o.l > q.x && y < q.y + q.o.w && y + o.w > q.y &&
            top < q.z + q.o.h && top + o.h > q.z
          );
          if (collides) continue;
          const support = all
            .filter((q) => q.z + q.o.h === top)
            .reduce((sum, q) =>
              sum + overlapArea(x, y, o.l, o.w, { x: q.x, y: q.y, l: q.o.l, w: q.o.w, h: q.o.h, top }), 0);
          if (support < o.l * o.w * SUPPORT_RATIO) continue;
          added.push({ item, x, y, o, z: top });
          left.set(item, (left.get(item) ?? 0) - 1);
          weightKg += boxWeight;
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (placed) break;
    }
  }
  return { placements: added, weightKg };
}

/** Empilha os itens da fila numa palete, camada a camada; consome item.boxes. */
function packPallet(size: PalletSize, queue: WorkItem[]): PalletResult | null {
  const warnings = new Set<string>();
  const baseArea = size.length * size.width;
  const weightLimit = PALLET_WEIGHT_LIMIT_KG[size.name] ?? Infinity;
  const items = [...queue]
    .filter((item) => item.boxes > 0 && fitsAnywhere(item.spec, size))
    .sort((a, b) => b.lg_num - a.lg_num || a.line_number - b.line_number);
  const remaining = new Map(items.map((item) => [item, item.boxes]));
  const boxes: PlacedBox[] = [];
  let below: Rect[] = [];
  let z = 0;
  let weightKg = 0;
  let layer = 0;

  const leftBoxes = () => [...remaining.values()].reduce((s, n) => s + n, 0);

  while (leftBoxes() > 0) {
    // Alturas possíveis para esta camada.
    const heights = [...new Set(items.flatMap((item) =>
      (remaining.get(item) ?? 0) > 0
        ? orientations(item.spec).filter((o) => z + o.h <= usableHeight(size)).map((o) => o.h)
        : []
    ))].sort((a, b) => a - b); // mais baixa primeiro: em empate fica a caixa deitada
    const fills: Array<{ fill: LayerFill; maxH: number; compact: number; columns: boolean; rotatedFirst: boolean }> = [];
    for (const h of heights) {
      for (const columns of [false, true]) {
        for (const rotatedFirst of [false, true]) {
          const fill = fillLayer(
            size, items, remaining, z, h - LAYER_TOLERANCE_MM, h, below, [], weightLimit - weightKg,
            rotatedFirst, columns,
          );
          if (fill.placements.length === 0) continue;
          fills.push({ fill, maxH: h, compact: compactness(fill.placements), columns, rotatedFirst });
        }
      }
    }
    if (fills.length === 0) break;
    // Regra dos LG: entre as camadas que cobrem quase o máximo, fica a que dá mais base ao
    // LG mais alto ainda por pôr (depois ao seguinte, e assim por diante); os LG mais altos
    // ficam em baixo. Em empate, a que cobre mais base.
    const maxArea = Math.max(...fills.map((f) => f.fill.fullArea));
    const lgOrder = [...new Set(items.filter((item) => (remaining.get(item) ?? 0) > 0).map((item) => item.lg_num))]
      .sort((a, b) => b - a);
    // Área de base ocupada por cada LG (maior LG primeiro): caixas deitadas contam o mesmo
    // que em pé, por isso não se preferem caixas em pé só por caberem mais numa camada.
    const lgVector = (fill: LayerFill) => lgOrder.map((lg) => fill.placements
      .filter((p) => p.item.lg_num === lg)
      .reduce((sum, p) => sum + p.o.l * p.o.w, 0));
    // Caixas encostadas primeiro: só se aceitam camadas sem buracos no meio (ou, se nenhuma
    // o conseguir, as mais compactas).
    const wide = fills.filter((f) => f.fill.fullArea >= maxArea * LG_PRIORITY_MIN_COVERAGE);
    const bestCompact = Math.max(...wide.map((f) => f.compact));
    const best = wide
      .filter((f) => f.compact >= Math.min(MIN_COMPACTNESS, bestCompact - 0.001))
      .map((f) => ({ ...f, vector: lgVector(f.fill) }))
      .sort((a, b) => {
        for (let i = 0; i < a.vector.length; i++) {
          if (a.vector[i] !== b.vector[i]) return b.vector[i] - a.vector[i];
        }
        return b.fill.fullArea - a.fill.fullArea ||
          b.compact - a.compact ||
          b.fill.placements.length - a.fill.placements.length;
      })[0];

    // Só para a camada escolhida: completar com colunas de duas caixas baixas (mais rápido
    // do que experimentar em todas as hipóteses).
    if (best.fill.fullArea < baseArea) {
      const withPairs = fillLayer(
        size, items, remaining, z, best.maxH - LAYER_TOLERANCE_MM, best.maxH, below, [], weightLimit - weightKg,
        best.rotatedFirst, best.columns, true,
      );
      if (withPairs.fullArea > best.fill.fullArea && compactness(withPairs.placements) >= Math.min(MIN_COMPACTNESS, best.compact)) {
        best.fill = withPairs;
      }
    }
    const coverage = best.fill.fullArea / baseArea;
    const lastLayer = coverage < MIN_STACK_COVERAGE;
    let placements: StackedPlacement[] = best.fill.placements.map((p) => ({ ...p, z: z + (p.dz ?? 0) }));
    let layerWeight = best.fill.weightKg;
    let layerHeight = best.fill.height;
    if (lastLayer) {
      // Camada de cima (nada vai por cima): os espaços junto às caixas levam as que sobram,
      // desde que não fiquem mais altas do que a camada.
      const used = new Map(remaining);
      for (const p of placements) used.set(p.item, (used.get(p.item) ?? 0) - 1);
      const existing = placements.filter((p) => p.z === z).map((p) => ({
        x: p.x, y: p.y, l: p.o.l, w: p.o.w, h: p.o.h, top: z + p.o.h,
      }));
      const filler = fillLayer(
        size, items, used, z, 1, best.maxH, below, existing,
        weightLimit - weightKg - layerWeight, false,
      );
      for (const p of filler.placements) used.set(p.item, (used.get(p.item) ?? 0) - 1);
      placements = [...placements, ...filler.placements.map((p) => ({ ...p, z: z + (p.dz ?? 0) }))];
      layerWeight += filler.weightKg;
      layerHeight = Math.max(layerHeight, filler.height);
      // Caixas baixas umas em cima das outras, para ficarem à altura da camada.
      const stacked = stackLowBoxes(
        size, items, used, placements, z + layerHeight, weightLimit - weightKg - layerWeight,
      );
      placements = [...placements, ...stacked.placements];
      layerWeight += stacked.weightKg;
    }
    // Ordem de colocação: regra do caracol (à volta da palete, de fora para dentro), de baixo para cima.
    placements.sort((a, b) =>
      a.z - b.z || compareRank(clockwiseSpiralRank(size, a, a.o), clockwiseSpiralRank(size, b, b.o))
    );

    layer += 1;
    let sequence = 0;
    const layerRects: Rect[] = [];
    for (const p of placements) {
      remaining.set(p.item, (remaining.get(p.item) ?? 0) - 1);
      p.item.boxes -= 1;
      if (p.item.spec.estimated) {
        warnings.add(
          `Artigo ${p.item.article_code} sem dimensões — usada medida padrão ${DEFAULT_BOX_MM.l}x${DEFAULT_BOX_MM.w}x${DEFAULT_BOX_MM.h}mm`,
        );
      }
      sequence += 1;
      boxes.push({
        order_line_id: p.item.order_line_id,
        line_number: p.item.line_number,
        article_code: p.item.article_code,
        lg_code: p.item.lg_code,
        store_code: p.item.store_code,
        layer,
        placement_sequence: sequence,
        pos_x: p.x,
        pos_y: p.y,
        pos_z: p.z,
        box_l: p.o.l,
        box_w: p.o.w,
        box_h: p.o.h,
        weight_kg: p.item.spec.weight_kg,
        orientation: p.o.label,
        rotated: p.o.label !== "CxLxA",
        pieces: p.item.spec.pieces_per_box,
      });
      layerRects.push({ x: p.x, y: p.y, l: p.o.l, w: p.o.w, h: p.o.h, top: p.z + p.o.h });
    }
    weightKg += layerWeight;
    // Só as caixas com a altura da camada servem de apoio à camada seguinte.
    const layerTop = z + layerHeight;
    below = layerRects.filter((r) => r.top >= layerTop - LAYER_TOLERANCE_MM);
    z = layerTop;
    if (lastLayer) break;
  }

  if (boxes.length === 0) return null;

  const top = Math.max(...boxes.map((b) => b.pos_z + b.box_h));
  const usedBase = boxes
    .filter((b) => b.pos_z === 0)
    .reduce((s, b) => s + b.box_l * b.box_w, 0);
  const usage = baseArea > 0 ? (usedBase / baseArea) * 100 : 0;
  if (usage < 40 && layer > 1) {
    warnings.add(`Palete sub-aproveitada (${usage.toFixed(1)}% da base ocupada)`);
  }

  return {
    size,
    boxes,
    height_mm: PALLET_BASE_HEIGHT_MM + top,
    layers: layer,
    warnings: Array.from(warnings),
    base_usage_pct: Math.round(usage * 10) / 10,
  };
}

/** Verificação final: contenção na base, altura e colisões. */
function validatePallet(p: PalletResult): string[] {
  const errs: string[] = [];
  for (const b of p.boxes) {
    if (
      b.pos_x < 0 || b.pos_y < 0 || b.pos_z < 0 ||
      b.pos_x + b.box_l > p.size.length ||
      b.pos_y + b.box_w > p.size.width
    ) {
      errs.push(`caixa ${b.article_code} fora da base (${b.pos_x},${b.pos_y} ${b.box_l}x${b.box_w})`);
    }
    if (PALLET_BASE_HEIGHT_MM + b.pos_z + b.box_h > maxTotalHeight(p.size)) {
      errs.push(
        `caixa ${b.article_code} acima do limite de ${maxTotalHeight(p.size)}mm para ${p.size.name}`,
      );
    }
  }
  const weightLimit = PALLET_WEIGHT_LIMIT_KG[p.size.name];
  const knownWeight = p.boxes.reduce((sum, box) => sum + (box.weight_kg ?? 0), 0);
  if (weightLimit !== undefined && knownWeight > weightLimit) {
    errs.push(`peso conhecido ${knownWeight.toFixed(1)}kg acima do limite de ${weightLimit}kg`);
  }
  for (let i = 0; i < p.boxes.length; i++) {
    const a = p.boxes[i];
    if (a.pos_z > 0) {
      const supportedArea = p.boxes
        .filter((b) => b.pos_z + b.box_h <= a.pos_z && b.pos_z + b.box_h >= a.pos_z - LAYER_TOLERANCE_MM)
        .reduce((area, b) =>
          area +
          Math.max(0, Math.min(a.pos_x + a.box_l, b.pos_x + b.box_l) - Math.max(a.pos_x, b.pos_x)) *
          Math.max(0, Math.min(a.pos_y + a.box_w, b.pos_y + b.box_w) - Math.max(a.pos_y, b.pos_y)),
        0);
      if (supportedArea < a.box_l * a.box_w * SUPPORT_RATIO) {
        errs.push(`caixa ${a.article_code} sem apoio estável (mínimo 70%)`);
      }
    }
    for (let j = i + 1; j < p.boxes.length; j++) {
      const b = p.boxes[j];
      if (
        a.pos_x < b.pos_x + b.box_l && a.pos_x + a.box_l > b.pos_x &&
        a.pos_y < b.pos_y + b.box_w && a.pos_y + a.box_w > b.pos_y &&
        a.pos_z < b.pos_z + b.box_h && a.pos_z + a.box_h > b.pos_z
      ) {
        errs.push(`caixas sobrepostas (${a.article_code} / ${b.article_code})`);
      }
    }
  }
  return [...new Set(errs)];
}

function cloneItems(items: WorkItem[]): WorkItem[] {
  return items.map((i) => ({ ...i }));
}

function totalBoxes(items: WorkItem[]): number {
  return items.reduce((s, i) => s + i.boxes, 0);
}

/** Empacota um grupo: escolhe o menor tamanho onde tudo caiba numa palete. */
function packGroup(group: WorkItem[]): PalletResult[] {
  const total = totalBoxes(group);
  if (total === 0) return [];

  for (const size of PALLET_SIZES.slice(0, 2)) {
    const trial = cloneItems(group);
    const p = packPallet(size, trial);
    if (p && p.boxes.length === total) {
      for (const i of group) i.boxes = 0;
      return [p];
    }
  }

  // Use 120x100 for a single-pallet fit only when a box cannot fit on 120x80
  // because of footprint, hard height, or an individual known-weight cap.
  const requiresLargerBase = group.some((item) => !fitsAnywhere(item.spec, EURO_PALLET));
  if (requiresLargerBase) {
    const trial = cloneItems(group);
    const p = packPallet(LARGER_JM_PALLET, trial);
    if (p && p.boxes.length === total) {
      for (const item of group) item.boxes = 0;
      return [p];
    }
  }

    // Normal multi-pallet fallback is 120x80; use 120x100 when the remaining
    // cartons cannot fit a 120x80 base, height, or known-weight ceiling.
  const out: PalletResult[] = [];
  while (totalBoxes(group) > 0) {
    const before = totalBoxes(group);
    let p = packPallet(EURO_PALLET, group);
    if (!p || p.boxes.length === 0) {
      p = packPallet(LARGER_JM_PALLET, group);
    }
    if (!p || p.boxes.length === 0) break;
    out.push(p);
    if (totalBoxes(group) >= before) break;
  }
  return out;
}

function referenceCount(pallet: PalletResult): number {
  return new Set(pallet.boxes.map((box) => box.article_code)).size;
}

function isMixedPallet(pallet: PalletResult): boolean {
  return new Set(pallet.boxes.map((box) => box.store_code)).size > 1 ||
    new Set(pallet.boxes.map((box) => box.lg_code)).size > 1;
}

function repackBoxes(boxes: PlacedBox[], size: PalletSize): PalletResult {
  if (boxes.length === 0) throw new Error("Não é possível criar uma palete vazia");
  const items: WorkItem[] = boxes.map((box) => ({
    order_line_id: box.order_line_id,
    line_number: box.line_number,
    article_code: box.article_code,
    description: null,
    lg_code: box.lg_code,
    lg_num: lgNumeric(box.lg_code),
    store_code: box.store_code,
    boxes: 1,
    spec: {
      l: box.box_l,
      w: box.box_w,
      h: box.box_h,
      pieces_per_box: box.pieces,
      estimated: false,
      weight_kg: box.weight_kg,
    },
  }));
  const result = packPallet(size, items);
  if (!result || result.boxes.length !== boxes.length) {
    throw new Error(`As ${boxes.length} caixas não cabem numa palete ${size.name}; escolha outra palete ou tamanho`);
  }
  const errors = validatePallet(result);
  if (errors.length) throw new Error(`Montagem inválida na palete ${size.name}: ${errors.join("; ")}`);
  return result;
}

function splitMixedPallets(pallets: PalletResult[]): PalletResult[] {
  const result: PalletResult[] = [];
  for (const pallet of pallets) {
    if (pallet.single_label || !isMixedPallet(pallet) || referenceCount(pallet) <= 8) {
      result.push(pallet);
      continue;
    }
    const byStore = new Map<string, PlacedBox[]>();
    for (const box of pallet.boxes) {
      const store = String(box.store_code || "").trim();
      if (!store) throw new Error("Não é possível dividir uma palete com caixas sem loja");
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store)!.push(box);
    }
    const stores = [...byStore.entries()].sort((a, b) =>
      Math.max(...b[1].map((box) => lgNumeric(box.lg_code))) -
        Math.max(...a[1].map((box) => lgNumeric(box.lg_code))) ||
      a[0].localeCompare(b[0])
    );
    const buckets: Array<{ boxes: PlacedBox[]; references: Set<string> }> = [];
    for (const [store, boxes] of stores) {
      const ownReferences = new Set(boxes.map((box) => box.article_code));
      if (ownReferences.size > 8) {
        throw new Error(`A loja ${store} tem ${ownReferences.size} referências: não é possível dividir sem separar as caixas dessa loja`);
      }
      let bucket = buckets.find(({ references }) =>
        new Set([...references, ...ownReferences]).size <= 8
      );
      if (!bucket) {
        bucket = { boxes: [], references: new Set() };
        buckets.push(bucket);
      }
      bucket.boxes.push(...boxes);
      for (const reference of ownReferences) bucket.references.add(reference);
    }
    if (buckets.length < 2) throw new Error("Não foi possível dividir as referências por loja");
    for (const bucket of buckets) {
      result.push(repackBoxes(bucket.boxes, pallet.size));
    }
  }
  return result;
}

function parsePlanEdits(raw: unknown): PlanEdit[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Correções inválidas ou demasiadas");
  return raw.map((edit): PlanEdit => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new Error("Correção inválida");
    const row = edit as Record<string, unknown>;
    if (row.type === "resize_pallet") {
      if (!Number.isSafeInteger(row.pallet_number) ||
        !PALLET_SIZES.some((size) => size.name === row.size)) throw new Error("Tamanho ou número de palete inválido");
      return { type: "resize_pallet", pallet_number: row.pallet_number as number, size: row.size as PalletSizeName };
    }
    if (row.type === "move_store") {
      if (!Number.isSafeInteger(row.from_pallet) ||
        (row.to_pallet !== null && !Number.isSafeInteger(row.to_pallet)) ||
        typeof row.store_code !== "string" || !row.store_code.trim()) {
        throw new Error("Loja ou número de palete inválido na correção");
      }
      return {
        type: "move_store",
        from_pallet: row.from_pallet as number,
        to_pallet: row.to_pallet as number | null,
        store_code: row.store_code.trim(),
      };
    }
    throw new Error("Tipo de correção desconhecido");
  });
}

function applyPlanEdits(pallets: PalletResult[], edits: PlanEdit[]): PalletResult[] {
  const result = [...pallets];
  for (const edit of edits) {
    const touched = edit.type === "resize_pallet"
      ? [edit.pallet_number]
      : [edit.from_pallet, ...(edit.to_pallet === null ? [] : [edit.to_pallet])];
    const locked = touched.find((n) => result[n - 1]?.single_label);
    if (locked) {
      throw new Error(`A palete ${locked} é uma palete completa: altere-a em «Paletes completas».`);
    }
    if (edit.type === "resize_pallet") {
      const index = edit.pallet_number - 1;
      const size = PALLET_SIZES.find((candidate) => candidate.name === edit.size)!;
      if (!result[index]) throw new Error(`Palete ${edit.pallet_number} inexistente`);
      result[index] = repackBoxes(result[index].boxes, size);
      continue;
    }
    const sourceIndex = edit.from_pallet - 1;
    const source = result[sourceIndex];
    if (!source) throw new Error(`Palete ${edit.from_pallet} inexistente`);
    const targetIndex = edit.to_pallet === null ? result.length : edit.to_pallet - 1;
    if (targetIndex === sourceIndex || (edit.to_pallet !== null && !result[targetIndex])) {
      throw new Error("Destino da movimentação inválido");
    }
    const moved = source.boxes.filter((box) => box.store_code === edit.store_code);
    if (!moved.length) throw new Error(`A loja ${edit.store_code} não está na palete ${edit.from_pallet}`);
    const remaining = source.boxes.filter((box) => box.store_code !== edit.store_code);
    const target = result[targetIndex];
    const targetSize = target?.size || source.size;
    const newTarget = repackBoxes([...(target?.boxes || []), ...moved], targetSize);
    if (remaining.length) result[sourceIndex] = repackBoxes(remaining, source.size);
    else result.splice(sourceIndex, 1);
    if (target) {
      const newIndex = remaining.length || targetIndex < sourceIndex ? targetIndex : targetIndex - 1;
      result[newIndex] = newTarget;
    } else result.push(newTarget);
  }
  return result;
}

function planBlockingErrors(pallets: PalletResult[], selection: PlanSelection): string[] {
  if (selection !== "split") return [];
  return pallets.flatMap((pallet, index) =>
    !pallet.single_label && isMixedPallet(pallet) && referenceCount(pallet) > 8
      ? [`A opção B não permite a palete ${index + 1} com ${referenceCount(pallet)} referências. Reveja a movimentação da loja.`]
      : []
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const denied = await requireRole(req, supabase, ["admin", "operador"], corsHeaders);
    if (denied) return denied;
    if (req.method === "GET") {
      return new Response(JSON.stringify({
        success: true, capabilities: { dry_run: true, preview_digest: true },
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ success: false, error: "Método não permitido" }), {
        status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return new Response(JSON.stringify({ success: false, error: "Request body must be a JSON object" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { order_id } = body;
    const p_force = body.p_force === undefined ? false : body.p_force;
    if (typeof p_force !== "boolean") {
      return new Response(JSON.stringify({ success: false, error: "p_force must be a boolean" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const dryRun = body.dry_run === true;
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return new Response(JSON.stringify({ success: false, error: "dry_run must be a boolean" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const selection: PlanSelection = body.selection === undefined ? "keep" : body.selection;
    if (selection !== "keep" && selection !== "split") {
      return new Response(JSON.stringify({ success: false, error: "Opção de paletização inválida" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const edits = parsePlanEdits(body.edits ?? []);
    if (!dryRun && (typeof body.preview_digest !== "string" || !/^[a-f0-9]{64}$/.test(body.preview_digest))) {
      return new Response(JSON.stringify({ success: false, error: "Confirme primeiro uma pré-visualização válida" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!order_id) {
      return new Response(JSON.stringify({ success: false, error: "order_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const bearerMatch = (req.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
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

    // Depois do ficheiro só o administrador altera; etiquetas emitidas exigem confirmação.
    const { data: currentOrder, error: orderError } = await supabase
      .from("orders")
      .select("status")
      .eq("id", order_id)
      .single();
    if (orderError || !currentOrder) {
      throw new Error(`Falha a verificar a encomenda: ${orderError?.message || order_id}`);
    }
    const [issuedLabels, changeBlock] = await Promise.all([
      supabase.from("labels").select("id", { count: "exact", head: true }).eq("order_id", order_id),
      // Regra de alteração: entregue = fechada; ficheiro já gerado = só administrador.
      supabase.rpc("order_change_block_reason", { p_order_id: order_id, p_actor_user_id: performedBy }),
    ]);
    if (issuedLabels.error || changeBlock.error || issuedLabels.count == null) {
      throw new Error(
        `Falha a verificar emissões anteriores: ${issuedLabels.error?.message || changeBlock.error?.message || "contagem indisponível"}`,
      );
    }
    if (changeBlock.data) {
      return new Response(
        JSON.stringify({
          success: false,
          error: changeBlock.data,
          desadv_blocked: true,
          permanent_block: true,
          code: "ORDER_CHANGE_BLOCKED",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!dryRun && (currentOrder.status === "etiquetas_geradas" || issuedLabels.count > 0) && !p_force) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Esta encomenda já tem etiquetas emitidas; é necessário confirmar a substituição da paletização.",
          requires_force: true,
          code: "REQUIRES_FORCE",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: orderLines, error: linesError } = await supabase
      .from("order_lines")
      .select("id, line_number, article_code, article_description, quantity, lg_code, store_code, quantity_cases")
      .eq("order_id", order_id)
      .order("line_number")
      .order("id");

    if (linesError) throw new Error(`Falha a ler linhas: ${linesError.message}`);
    if (!orderLines || orderLines.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "Encomenda sem linhas" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const missingStoreLines = (orderLines as OrderLineRow[])
      .filter((line) => !String(line.store_code || "").trim())
      .map((line) => line.line_number);
    if (missingStoreLines.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Código de loja em falta numa ou mais linhas; corrija as linhas antes de voltar a paletizar.",
          missing_store_line_numbers: missingStoreLines,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const codes = [...new Set((orderLines as OrderLineRow[]).map((l) => l.article_code))];
    const [byCode, byEan] = await Promise.all([
      supabase.from("articles")
        .select("code, ean, pieces_per_box, dimensions_cm, weight_kg").in("code", codes),
      supabase.from("articles")
        .select("code, ean, pieces_per_box, dimensions_cm, weight_kg").in("ean", codes),
    ]);
    if (byCode.error || byEan.error) {
      throw new Error(`Falha a ler artigos: ${byCode.error?.message || byEan.error?.message}`);
    }
    const articles = [...new Map(
      [...(byCode.data || []), ...(byEan.data || [])].map((article) => [article.code, article]),
    ).values()];

    const specByCode = new Map<string, BoxSpec>();
    for (const a of articles) {
      const dims = parseDims(a.dimensions_cm);
      const weightKg = a.weight_kg == null ? null : Number(a.weight_kg);
      const spec: BoxSpec = {
        l: dims?.l ?? DEFAULT_BOX_MM.l,
        w: dims?.w ?? DEFAULT_BOX_MM.w,
        h: dims?.h ?? DEFAULT_BOX_MM.h,
        pieces_per_box: a.pieces_per_box || 1,
        estimated: !dims,
        // weight_kg is confirmed as the weight of one box/UMC, not one piece.
        weight_kg: weightKg !== null && Number.isFinite(weightKg) && weightKg >= 0
          ? weightKg
          : null,
      };
      specByCode.set(a.code, spec);
    }
    for (const a of articles) {
      if (a.ean && !specByCode.has(a.ean)) {
        specByCode.set(a.ean, specByCode.get(a.code)!);
      }
    }

    const globalWarnings: string[] = [];

    const items: WorkItem[] = (orderLines as OrderLineRow[]).map((line) => {
      const spec =
        specByCode.get(line.article_code) ?? {
          ...DEFAULT_BOX_MM,
          pieces_per_box: 1,
          estimated: true,
          weight_kg: null,
        };
      const boxes =
        line.quantity_cases && line.quantity_cases > 0
          ? Math.ceil(line.quantity_cases)
          : Math.max(1, Math.ceil(line.quantity / Math.max(1, spec.pieces_per_box)));
      if (spec.estimated) {
        globalWarnings.push(`Artigo ${line.article_code}: dimensões em falta, usada medida padrão`);
      }
      return {
        order_line_id: line.id,
        line_number: line.line_number,
        article_code: line.article_code,
        description: line.article_description,
        lg_code: line.lg_code,
        lg_num: lgNumeric(line.lg_code),
        store_code: String(line.store_code).trim(),
        boxes,
        spec,
      };
    });

    // ── Artigos impossíveis de paletizar ──
    const impossible = items.filter((i) => !fitsAnywhere(i.spec, LARGER_JM_PALLET));
    if (impossible.length > 0) {
      const list = [...new Set(impossible.map(
        (i) => `${i.article_code} (${i.spec.l}x${i.spec.w}x${i.spec.h}mm)`,
      ))];
      return new Response(
        JSON.stringify({
          success: false,
          error: `Artigos impossíveis de paletizar — não cabem numa palete 120x100 em nenhuma orientação: ${list.join(", ")}`,
          impossible_articles: list,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const expectedBoxesByLine = new Map<string, number>();
    for (const i of items) expectedBoxesByLine.set(i.order_line_id, i.boxes);
    const expectedTotal = totalBoxes(items);

    // ── Paletes completas definidas pelo administrador (1 SOC e 1 etiqueta cada) ──
    // As caixas escolhidas saem primeiro; o resto segue as regras normais.
    const { data: fullPalletRows, error: fullPalletsError } = await supabase
      .from("order_full_pallets")
      .select("position, store_code, lines")
      .eq("order_id", order_id)
      .order("position");
    if (fullPalletsError) throw new Error(`Falha a ler as paletes completas: ${fullPalletsError.message}`);
    const fullPalletDefs = (fullPalletRows || []) as FullPalletRow[];
    const fullPallets: PalletResult[] = [];
    for (const def of fullPalletDefs) {
      const store = String(def.store_code || "").trim();
      const group: WorkItem[] = [];
      for (const line of Array.isArray(def.lines) ? def.lines : []) {
        const item = items.find((i) => i.order_line_id === line.order_line_id && i.store_code === store);
        const wanted = Math.floor(Number(line.boxes) || 0);
        if (!item || wanted < 1) continue;
        const take = Math.min(wanted, item.boxes);
        if (take < wanted) {
          globalWarnings.push(
            `Palete completa ${def.position} (loja ${store}): artigo ${item.article_code} só tem ${item.boxes} caixa(s) disponíveis`,
          );
        }
        if (take < 1) continue;
        item.boxes -= take;
        group.push({ ...item, boxes: take });
      }
      if (group.length === 0) {
        globalWarnings.push(`Palete completa ${def.position} (loja ${store}) ignorada: artigos já não existem na encomenda`);
        continue;
      }
      group.sort((a, b) => b.lg_num - a.lg_num || a.line_number - b.line_number);
      const packed = packGroup(group);
      if (packed.length > 1) {
        globalWarnings.push(
          `Palete completa ${def.position} (loja ${store}) não cabe numa só palete: foram criadas ${packed.length} paletes completas`,
        );
      }
      for (const p of packed) {
        p.single_label = true;
        fullPallets.push(p);
      }
    }

    // ── Agrupar por LG (desc) e aplicar a REGRA DAS 5 CAIXAS ──
    const lgKeys = [...new Set(items.map((i) => i.lg_code || ""))].sort(
      (a, b) => lgNumeric(b) - lgNumeric(a),
    );

    const dedicated: PalletResult[] = [];
    const leftovers: WorkItem[] = [];

    const sortGroup = (a: WorkItem, b: WorkItem) => {
      const sa = parseInt(a.store_code || "0", 10) || 0;
      const sb = parseInt(b.store_code || "0", 10) || 0;
      if (sa !== sb) return sa - sb;
      return a.line_number - b.line_number;
    };

    for (const lg of lgKeys) {
      const group = items.filter((i) => (i.lg_code || "") === lg).sort(sortGroup);
      const groupBoxes = totalBoxes(group);

      if (groupBoxes > MIXED_MAX_BOXES_PER_LG) {
        // LG com mais de 5 caixas → palete(s) dedicada(s)
        dedicated.push(...packGroup(cloneItems(group).map((g) => g)));
      } else {
        // LG com 5 ou menos caixas → pode ir para palete mista
        leftovers.push(...cloneItems(group));
      }
    }

    // ── Paletes mistas, do LG maior para o menor ──
    // Queue order controls placement sequence. LGs may share a layer; they are
    // not separated into vertical strata.
    leftovers.sort((a, b) => {
      if (b.lg_num !== a.lg_num) return b.lg_num - a.lg_num;
      return sortGroup(a, b);
    });

    const mixedPallets: PalletResult[] = [];
    while (totalBoxes(leftovers) > 0) {
      const before = totalBoxes(leftovers);
      const remaining = totalBoxes(leftovers);
      let chosen: PalletResult | null = null;
      for (const size of PALLET_SIZES.slice(0, 2)) {
        const trial = cloneItems(leftovers);
        const p = packPallet(size, trial);
        if (p && p.boxes.length === remaining) {
          chosen = p;
          for (const i of leftovers) i.boxes = 0;
          break;
        }
      }
      if (!chosen && leftovers.some((item) => item.boxes > 0 && !fitsAnywhere(item.spec, EURO_PALLET))) {
        const trial = cloneItems(leftovers);
        const p = packPallet(LARGER_JM_PALLET, trial);
        if (p && p.boxes.length === remaining) {
          chosen = p;
          for (const item of leftovers) item.boxes = 0;
        }
      }
      if (!chosen) {
        chosen = packPallet(EURO_PALLET, leftovers);
        if (!chosen || chosen.boxes.length === 0) {
          chosen = packPallet(LARGER_JM_PALLET, leftovers);
        }
      }
      if (!chosen || chosen.boxes.length === 0) break;
      mixedPallets.push(chosen);
      if (totalBoxes(leftovers) >= before) break;
    }

    // ── Ordenar paletes: LG mais alto primeiro ──
    let allPallets = [...fullPallets, ...dedicated, ...mixedPallets];
    const palletLgMax = (p: PalletResult) =>
      Math.max(...p.boxes.map((b) => lgNumeric(b.lg_code)), -1);
    allPallets.sort((a, b) => {
      const d = palletLgMax(b) - palletLgMax(a);
      if (d !== 0) return d;
      const sa = Math.min(...a.boxes.map((x) => parseInt(x.store_code || "0", 10) || 0));
      const sb = Math.min(...b.boxes.map((x) => parseInt(x.store_code || "0", 10) || 0));
      return sa - sb;
    });
    const requiresChoice = allPallets.some((pallet) =>
      !pallet.single_label && isMixedPallet(pallet) && referenceCount(pallet) > 8
    );
    if (selection === "split" && requiresChoice) {
      allPallets = splitMixedPallets(allPallets);
    }
    allPallets = applyPlanEdits(allPallets, edits);
    if (allPallets.length === 1) {
      allPallets[0].warnings.push(
        "Plano composto por uma única palete — confirmar estabilidade e adequação da carga antes do transporte.",
      );
    }

    // ── Validações finais ──
    const packedByLine = new Map<string, number>();
    for (const p of allPallets) {
      for (const b of p.boxes) {
        packedByLine.set(b.order_line_id, (packedByLine.get(b.order_line_id) || 0) + 1);
      }
    }
    let packedTotal = 0;
    for (const [lineId, expected] of expectedBoxesByLine) {
      const got = packedByLine.get(lineId) || 0;
      packedTotal += got;
      if (got !== expected) {
        globalWarnings.push(`Linha ${lineId}: paletizadas ${got} de ${expected} caixas`);
      }
    }
    if (packedTotal !== expectedTotal) {
      globalWarnings.push(
        `Total de caixas paletizadas (${packedTotal}) difere do total da encomenda (${expectedTotal})`,
      );
    }
    const unfulfilledLines = [...expectedBoxesByLine.entries()]
      .filter(([lineId, expected]) => (packedByLine.get(lineId) || 0) !== expected);
    if (unfulfilledLines.length > 0 || packedTotal !== expectedTotal) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Paletização incompleta: foram acomodadas ${packedTotal} de ${expectedTotal} caixas. O plano anterior não foi alterado.`,
          expected_boxes: expectedTotal,
          packed_boxes: packedTotal,
          incomplete_lines: unfulfilledLines.map(([lineId, expected]) => ({
            line_id: lineId,
            expected,
            packed: packedByLine.get(lineId) || 0,
          })),
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    for (const [index, p] of allPallets.entries()) {
      const lgs = [...new Set(p.boxes.map((b) => b.lg_code || ""))];
      if (lgs.length > 1 && !p.single_label) {
        for (const lg of lgs) {
          const n = p.boxes.filter((b) => (b.lg_code || "") === lg).length;
          if (n > MIXED_MAX_BOXES_PER_LG) {
            p.warnings.push(`Palete mista com ${n} caixas do LG ${lg || "s/ LG"} (limite ${MIXED_MAX_BOXES_PER_LG})`);
          }
        }
      }

      const missingWeightArticles = [...new Set(
        p.boxes.filter((b) => b.weight_kg === null).map((b) => b.article_code),
      )];
      const knownPalletWeight = p.boxes.reduce(
        (sum, b) => sum + (b.weight_kg ?? 0),
        0,
      );
      if (missingWeightArticles.length > 0) {
        p.warnings.push(`Peso em falta para artigo(s): ${missingWeightArticles.join(", ")}`);
      }
      const weightLimit = PALLET_WEIGHT_LIMIT_KG[p.size.name];
      if (weightLimit !== undefined && knownPalletWeight > weightLimit) {
        const isPartialEstimate = missingWeightArticles.length > 0;
        p.warnings.push(
          `${isPartialEstimate ? "Peso conhecido mínimo" : "Peso estimado"} ${knownPalletWeight.toFixed(1)}kg excede o limite para ${p.size.name} (${weightLimit}kg)`,
        );
      }

      const boxWeightByArticle = new Map<string, number>();
      for (const box of p.boxes) {
        if (box.weight_kg !== null) {
          boxWeightByArticle.set(
            box.article_code,
            Math.max(
              boxWeightByArticle.get(box.article_code) ?? 0,
              box.weight_kg,
            ),
          );
        }
      }
      for (const [articleCode, boxWeight] of boxWeightByArticle) {
        if (boxWeight > 20) {
          p.warnings.push(
            `AVISO FORTE: UMC do artigo ${articleCode} pesa ${boxWeight}kg (mais de 20kg)`,
          );
        } else if (boxWeight > 15) {
          p.warnings.push(
            `UMC do artigo ${articleCode} pesa ${boxWeight}kg (mais de 15kg)`,
          );
        }
      }

      const articleReferences = new Set(p.boxes.map((b) => b.article_code));
      if (!p.single_label && (lgs.length > 1 || new Set(p.boxes.map((b) => b.store_code)).size > 1) && articleReferences.size > 8) {
        p.warnings.push(
          `Palete ${index + 1} tem ${articleReferences.size} referências (limite recomendado: 8)`,
        );
      }
    }

    // ── Verificação final de contenção/colisões (nunca gravar planos inválidos) ──
    for (let idx = 0; idx < allPallets.length; idx++) {
      const p = allPallets[idx];
      let errs = validatePallet(p);
      if (errs.length > 0) {
        // recalcular esta palete a partir das suas próprias caixas
        const requeue: WorkItem[] = p.boxes.map((b) => ({
          order_line_id: b.order_line_id,
          line_number: b.line_number,
          article_code: b.article_code,
          description: null,
          lg_code: b.lg_code,
          lg_num: lgNumeric(b.lg_code),
          store_code: b.store_code,
          boxes: 1,
          spec: {
            l: b.box_l,
            w: b.box_w,
            h: b.box_h,
            pieces_per_box: b.pieces,
            estimated: false,
            weight_kg: b.weight_kg,
          },
        }));
        let redone = packPallet(EURO_PALLET, cloneItems(requeue));
        if (!redone || redone.boxes.length !== p.boxes.length) {
          redone = packPallet(LARGER_JM_PALLET, cloneItems(requeue));
        }
        if (redone && redone.boxes.length === p.boxes.length) {
          redone.warnings = [...new Set([...p.warnings, ...redone.warnings])];
          redone.single_label = p.single_label;
          allPallets[idx] = redone;
          errs = validatePallet(redone);
        }
      }
      if (errs.length > 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Palete ${idx + 1}: impossível acomodar as caixas dentro das medidas sem ultrapassar a base. Revise dimensões dos artigos.`,
            details: errs,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const blockingErrors = planBlockingErrors(allPallets, selection);

    // Build a deterministic payload for both preview and confirmation. This
    // section must not allocate a SOC or write anything to the database.
    const palletPayload = allPallets.map((p, index) => {
      const lgs = [...new Set(p.boxes.map((b) => b.lg_code).filter(Boolean))] as string[];
      const stores = [...new Set(p.boxes.map((b) => b.store_code).filter(Boolean))] as string[];
      const isMixed = lgs.length > 1 || stores.length > 1;
      const pieces = p.boxes.reduce((s, b) => s + b.pieces, 0);
      return {
        pallet_number: index + 1,
        pallet_size: p.size.name,
        base_length_mm: p.size.length,
        base_width_mm: p.size.width,
        height_mm: p.height_mm,
        total_layers: p.layers,
        total_pieces: pieces,
        is_mixed: isMixed,
        single_label: p.single_label === true,
        base_usage_pct: p.base_usage_pct,
        warnings: p.warnings,
        boxes: p.boxes.map((b) => ({
          order_line_id: b.order_line_id,
          quantity: b.pieces,
          layer_number: b.layer,
          placement_sequence: b.placement_sequence,
          pos_x_mm: b.pos_x,
          pos_y_mm: b.pos_y,
          pos_z_mm: b.pos_z,
          box_length_mm: b.box_l,
          box_width_mm: b.box_w,
          box_height_mm: b.box_h,
          rotated: b.rotated,
          orientation: b.orientation,
          article_code: b.article_code,
          store_code: String(b.store_code || "").trim(),
          lg_code: b.lg_code,
        })),
      };
    });

    const digestInput = JSON.stringify({
      order_id, selection, edits, palletPayload, full_pallets: fullPalletDefs,
      order_lines: [...(orderLines as OrderLineRow[])].sort((a, b) => a.id.localeCompare(b.id)),
      article_specs: [...specByCode].sort(([a], [b]) => a.localeCompare(b)),
    });
    const digestBytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(digestInput),
    ));
    const previewDigest = [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (dryRun) {
      const descriptions = new Map((orderLines as OrderLineRow[]).map((line) =>
        [line.id, line.article_description]
      ));
      return new Response(JSON.stringify({
        success: true,
        data: {
          preview: true,
          order_id,
          total_pallets: allPallets.length,
          total_boxes: packedTotal,
          requires_choice: requiresChoice,
          preview_digest: previewDigest,
          blocking_errors: blockingErrors,
          warnings: [...new Set(globalWarnings)],
          pallets: allPallets.map((p, index) => ({
            id: `preview-${index + 1}`,
            pallet_number: index + 1,
            pallet_size: p.size.name,
            base_length_mm: p.size.length,
            base_width_mm: p.size.width,
            height_mm: p.height_mm,
            total_layers: p.layers,
            total_boxes: p.boxes.length,
            total_pieces: p.boxes.reduce((sum, box) => sum + box.pieces, 0),
            is_mixed: isMixedPallet(p),
            single_label: p.single_label === true,
            base_usage_pct: p.base_usage_pct,
            lg_codes: [...new Set(p.boxes.map((box) => box.lg_code).filter(Boolean))],
            store_codes: [...new Set(p.boxes.map((box) => box.store_code).filter(Boolean))],
            warnings: p.warnings,
            boxes: p.boxes.map((box, boxIndex) => ({
              id: `preview-${index + 1}-${boxIndex + 1}`,
              order_line_id: box.order_line_id,
              article_code: box.article_code,
              article_description: descriptions.get(box.order_line_id),
              store_code: box.store_code,
              lg_code: box.lg_code,
              layer_number: box.layer,
              placement_sequence: box.placement_sequence,
              pos_x_mm: box.pos_x,
              pos_y_mm: box.pos_y,
              pos_z_mm: box.pos_z,
              box_length_mm: box.box_l,
              box_width_mm: box.box_w,
              box_height_mm: box.box_h,
              rotated: box.rotated,
              orientation: box.orientation,
              quantity: box.pieces,
            })),
          })),
        },
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (body.preview_digest !== previewDigest) {
      return new Response(JSON.stringify({
        success: false,
        code: "PREVIEW_STALE",
        error: "A encomenda ou o plano mudou desde a pré-visualização. Volte a pré-visualizar antes de gravar.",
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (blockingErrors.length) {
      return new Response(JSON.stringify({
        success: false, code: "INVALID_SPLIT", error: blockingErrors.join("; "),
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Validation, SOC allocation, audit and replacement are atomic in the RPC.
    const { data: replacement, error: replacementError } = await supabase.rpc(
      "replace_pallet_plan_with_choice",
      {
        p_order_id: order_id,
        p_pallets: palletPayload,
        p_force,
        p_actor_user_id: performedBy,
        p_audit: {
          selection,
          mode: edits.length ? "manual" : selection === "split" ? "B" : "A",
          corrections: edits,
          preview_digest: previewDigest,
        },
      },
    );
    if (replacementError) {
      throw new Error(`Falha a substituir a paletização atomicamente: ${replacementError.message}`);
    }
    if (!replacement || !Array.isArray(replacement.pallets)) {
      throw new Error("A substituição atómica devolveu uma resposta inválida.");
    }
    if (
      replacement.total_pallets !== allPallets.length ||
      replacement.total_boxes !== packedTotal ||
      replacement.pallets.length !== allPallets.length
    ) {
      throw new Error("A substituição atómica devolveu totais diferentes do plano calculado.");
    }

    const savedPallets = allPallets.map((p, index) => {
      const saved = replacement.pallets[index];
      if (
        !saved?.id ||
        saved.pallet_number !== index + 1 ||
        saved.total_boxes !== p.boxes.length ||
        !Array.isArray(saved.containers)
      ) {
        throw new Error(`A substituição atómica devolveu dados inválidos para a palete ${index + 1}.`);
      }
      const lgs = [...new Set(p.boxes.map((b) => b.lg_code).filter(Boolean))] as string[];
      const stores = [...new Set(p.boxes.map((b) => b.store_code).filter(Boolean))] as string[];
      const isMixed = lgs.length > 1 || stores.length > 1;
      const pieces = p.boxes.reduce((s, b) => s + b.pieces, 0);
      return {
        id: saved.id,
        pallet_number: saved.pallet_number,
        pallet_size: p.size.name,
        base_length_mm: p.size.length,
        base_width_mm: p.size.width,
        height_mm: p.height_mm,
        total_layers: p.layers,
        total_boxes: saved.total_boxes,
        total_pieces: pieces,
        is_mixed: isMixed,
        single_label: p.single_label === true,
        lg_codes: lgs,
        store_codes: stores,
        containers: saved.containers,
        base_usage_pct: p.base_usage_pct,
        warnings: p.warnings,
      };
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          order_id,
          total_pallets: allPallets.length,
          total_boxes: packedTotal,
          pallets: savedPallets,
          warnings: [...new Set(globalWarnings)],
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("build-pallet-plan:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
