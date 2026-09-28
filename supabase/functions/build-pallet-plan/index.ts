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
const SUPPORT_RATIO = 0.7; // apoio mínimo da base sobre caixas inferiores
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

/**
 * Deterministic clockwise, ring-by-ring ordering of feasible extreme points.
 * Coordinates use x=right and y=depth, starting at the front-left corner.
 * Irregular box sizes/support surfaces can interrupt a perfect spiral; collision,
 * containment, and support checks always take precedence over this preference.
 */
function clockwiseSpiralRank(
  size: PalletSize,
  point: Point,
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

// ── Packer 3D por extreme points ─────────────────────────────
interface Point {
  x: number;
  y: number;
  z: number;
}

class Packer {
  size: PalletSize;
  placed: PlacedBox[] = [];
  points: Point[] = [{ x: 0, y: 0, z: 0 }];
  knownWeightKg = 0;

  constructor(size: PalletSize) {
    this.size = size;
  }

  private collides(x: number, y: number, z: number, o: Orient): boolean {
    for (const b of this.placed) {
      if (
        x < b.pos_x + b.box_l &&
        x + o.l > b.pos_x &&
        y < b.pos_y + b.box_w &&
        y + o.w > b.pos_y &&
        z < b.pos_z + b.box_h &&
        z + o.h > b.pos_z
      ) {
        return true;
      }
    }
    return false;
  }

  /** Contenção total: a caixa tem de ficar 100% dentro da base e abaixo da altura útil. */
  private contained(x: number, y: number, z: number, o: Orient): boolean {
    return (
      x >= 0 && y >= 0 && z >= 0 &&
      x + o.l <= this.size.length &&
      y + o.w <= this.size.width &&
      z + o.h <= usableHeight(this.size)
    );
  }

  private supported(x: number, y: number, z: number, o: Orient): boolean {
    if (z === 0) return true;
    const need = o.l * o.w * SUPPORT_RATIO;
    let area = 0;
    for (const b of this.placed) {
      if (b.pos_z + b.box_h !== z) continue;
      const ox = Math.max(0, Math.min(x + o.l, b.pos_x + b.box_l) - Math.max(x, b.pos_x));
      const oy = Math.max(0, Math.min(y + o.w, b.pos_y + b.box_w) - Math.max(y, b.pos_y));
      area += ox * oy;
    }
    return area >= need;
  }

  /** Tenta colocar uma caixa; devolve a colocação ou null. */
  tryPlace(item: WorkItem, exactZ?: number): PlacedBox | null {
    const weightLimit = PALLET_WEIGHT_LIMIT_KG[this.size.name];
    if (
      weightLimit !== undefined &&
      item.spec.weight_kg !== null &&
      this.knownWeightKg + item.spec.weight_kg > weightLimit
    ) {
      return null;
    }

    for (const o of orientations(item.spec)) {
      const points = [...this.points]
        .filter((point) => exactZ === undefined || point.z === exactZ)
        .sort((a, b) => {
          if (a.z !== b.z) return a.z - b.z;
          const ar = clockwiseSpiralRank(this.size, a, o);
          const br = clockwiseSpiralRank(this.size, b, o);
          return ar[0] - br[0] || ar[1] - br[1] || ar[2] - br[2] || ar[3] - br[3];
        });
      for (const p of points) {
        if (!this.contained(p.x, p.y, p.z, o)) continue;
        if (this.collides(p.x, p.y, p.z, o)) continue;
        if (!this.supported(p.x, p.y, p.z, o)) continue;

        const box: PlacedBox = {
          order_line_id: item.order_line_id,
          line_number: item.line_number,
          article_code: item.article_code,
          lg_code: item.lg_code,
          store_code: item.store_code,
          layer: 0,
          placement_sequence: 0,
          pos_x: p.x,
          pos_y: p.y,
          pos_z: p.z,
          box_l: o.l,
          box_w: o.w,
          box_h: o.h,
          weight_kg: item.spec.weight_kg,
          orientation: o.label,
          rotated: o.label !== "CxLxA",
          pieces: item.spec.pieces_per_box,
        };
        this.placed.push(box);
        this.knownWeightKg += box.weight_kg ?? 0;

        // consumir o ponto usado e gerar novos extreme points
        this.points = this.points.filter(
          (q) => !(q.x === p.x && q.y === p.y && q.z === p.z),
        );
        const candidates: Point[] = [
          { x: p.x + o.l, y: p.y, z: p.z },
          { x: p.x, y: p.y + o.w, z: p.z },
          { x: p.x, y: p.y, z: p.z + o.h },
        ];
        for (const c of candidates) {
          if (
            c.x >= this.size.length ||
            c.y >= this.size.width ||
            c.z >= usableHeight(this.size)
          ) continue;
          if (this.points.some((q) => q.x === c.x && q.y === c.y && q.z === c.z)) continue;
          this.points.push(c);
        }
        return box;
      }
    }
    return null;
  }

  discardLevel(z: number): void {
    this.points = this.points.filter((point) => point.z !== z);
  }
}

/** Empilha os itens da fila numa palete; consome item.boxes. */
function packPallet(size: PalletSize, queue: WorkItem[]): PalletResult | null {
  const packer = new Packer(size);
  const warnings = new Set<string>();
  const orderedItems = [...queue].sort(
    (a, b) => b.lg_num - a.lg_num || a.line_number - b.line_number,
  );
  const placeOneAtLevel = (item: WorkItem, z: number): boolean => {
    if (item.boxes <= 0 || !fitsAnywhere(item.spec, size)) return false;
    const placed = packer.tryPlace(item, z);
    if (!placed) return false;
    if (item.spec.estimated) {
      warnings.add(
        `Artigo ${item.article_code} sem dimensões — usada medida padrão ${DEFAULT_BOX_MM.l}x${DEFAULT_BOX_MM.w}x${DEFAULT_BOX_MM.h}mm`,
      );
    }
    item.boxes -= 1;
    return true;
  };

  // First exhaust every feasible position on the pallet base, trying items in
  // descending LG order. A box that does not fit the current base gaps does not
  // block a different store/LG from filling them.
  let placedAtBase: boolean;
  do {
    placedAtBase = false;
    for (const item of orderedItems) {
      while (placeOneAtLevel(item, 0)) placedAtBase = true;
    }
  } while (placedAtBase);

  // Once no remaining box fits the base, work upward through the lowest exposed
  // supported surfaces. LG order applies to placement within a layer, not to
  // separate vertical strata; multiple stores/LGs may occupy the same layer.
  packer.discardLevel(0);
  while (true) {
    const z = Math.min(...packer.points.map((point) => point.z));
    if (!Number.isFinite(z)) break;

    let placedAtLevel: boolean;
    do {
      placedAtLevel = false;
      for (const item of orderedItems) {
        while (placeOneAtLevel(item, z)) placedAtLevel = true;
      }
    } while (placedAtLevel);

    // If no remaining box fits here, later placements cannot create new space
    // at this same surface height; move on to the next exposed level.
    packer.discardLevel(z);
  }

  const boxes = packer.placed;
  if (boxes.length === 0) return null;

  // camadas aproximadas: níveis distintos de z
  const levels = [...new Set(boxes.map((b) => b.pos_z))].sort((a, b) => a - b);
  for (const b of boxes) b.layer = levels.indexOf(b.pos_z) + 1;
  // Preserve the actual deterministic packing chronology within each layer.
  // The packer's placed array records base-first placement, following its
  // clockwise ring-by-ring extreme-point preference (subject to fit/support).
  const nextSequenceByLayer = new Map<number, number>();
  for (const b of boxes) {
    const next = (nextSequenceByLayer.get(b.layer) || 0) + 1;
    b.placement_sequence = next;
    nextSequenceByLayer.set(b.layer, next);
  }

  const top = Math.max(...boxes.map((b) => b.pos_z + b.box_h));
  const baseArea = size.length * size.width;
  const usedBase = boxes
    .filter((b) => b.pos_z === 0)
    .reduce((s, b) => s + b.box_l * b.box_w, 0);
  const usage = baseArea > 0 ? (usedBase / baseArea) * 100 : 0;
  if (usage < 40 && levels.length > 1) {
    warnings.add(`Palete sub-aproveitada (${usage.toFixed(1)}% da base ocupada)`);
  }

  return {
    size,
    boxes,
    height_mm: PALLET_BASE_HEIGHT_MM + top,
    layers: levels.length,
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
        .filter((b) => b.pos_z + b.box_h === a.pos_z)
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
    if (!isMixedPallet(pallet) || referenceCount(pallet) <= 8) {
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
    isMixedPallet(pallet) && referenceCount(pallet) > 8
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
    let allPallets = [...dedicated, ...mixedPallets];
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
      isMixedPallet(pallet) && referenceCount(pallet) > 8
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
      if (lgs.length > 1) {
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
      if ((lgs.length > 1 || new Set(p.boxes.map((b) => b.store_code)).size > 1) && articleReferences.size > 8) {
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
      order_id, selection, edits, palletPayload,
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
