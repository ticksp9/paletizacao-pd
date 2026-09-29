import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Load the real packing/splitting helpers without starting Deno.serve or a DB.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const helpers = source.slice(
  source.indexOf("const MAX_PHYSICAL_HEIGHT_MM"),
  source.indexOf("Deno.serve("),
);
const compiled = ts.transpileModule(helpers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const {
  packPallet, splitMixedPallets, applyPlanEdits, validatePallet, referenceCount, planBlockingErrors, sizes,
} = runInNewContext(`${compiled}\n({
  packPallet, splitMixedPallets, applyPlanEdits, validatePallet, referenceCount,
  planBlockingErrors, sizes: PALLET_SIZES
})`);

function makePallet(refs = 9) {
  const items = Array.from({ length: refs }, (_, index) => ({
    order_line_id: `line-${index}`,
    line_number: index + 1,
    article_code: `ART-${index}`,
    description: null,
    lg_code: `LG${900 - index}`,
    lg_num: 900 - index,
    store_code: `LOJA-${index}`,
    boxes: 1,
    spec: { l: 200, w: 200, h: 100, pieces_per_box: 1, estimated: false, weight_kg: 2 },
  }));
  const pallet = packPallet(sizes[1], items);
  assert.equal(pallet.boxes.length, refs);
  return pallet;
}

test("option B splits an over-eight-reference mixed pallet by whole store", () => {
  const pallet = makePallet();
  assert.equal(referenceCount(pallet), 9);
  const split = splitMixedPallets([pallet]);
  assert.equal(split.length, 2);
  assert.equal(split.reduce((sum, p) => sum + p.boxes.length, 0), 9);
  assert.ok(split.every((p) => referenceCount(p) <= 8 && validatePallet(p).length === 0));
  const store = split[0].boxes[0].store_code;
  const changed = applyPlanEdits(split, [{
    type: "move_store", from_pallet: 1, to_pallet: 2, store_code: store,
  }, { type: "resize_pallet", pallet_number: 2, size: "120x100" }]);
  assert.equal(changed[1].size.name, "120x100");
  assert.equal(changed.reduce((sum, p) => sum + p.boxes.length, 0), 9);
  assert.ok(changed.every((p) => validatePallet(p).length === 0));
  assert.equal(changed[0].boxes.filter((b) => b.store_code === store).length, 0);
  assert.equal(changed[1].boxes.filter((b) => b.store_code === store).length, 1);
});

test("moving an entire store to a new pallet and restoring one pallet is possible", () => {
  const pallet = makePallet(3);
  const store = pallet.boxes[0].store_code;
  const moved = applyPlanEdits([pallet], [{
    type: "move_store", from_pallet: 1, to_pallet: null, store_code: store,
  }]);
  assert.equal(moved.length, 2);
  assert.equal(moved[0].boxes.length, 2);
  assert.equal(moved[1].boxes.length, 1);
  assert.equal(moved[1].boxes[0].store_code, store);
});

test("option B blocks a manual move that recombines more than eight references", () => {
  const split = splitMixedPallets([makePallet()]);
  const changed = applyPlanEdits(split, [{
    type: "move_store", from_pallet: 2, to_pallet: 1,
    store_code: split[1].boxes[0].store_code,
  }]);
  assert.equal(changed.length, 1);
  assert.equal(referenceCount(changed[0]), 9);
  assert.match(planBlockingErrors(changed, "split").join(" "), /opção B não permite/);
  assert.equal(planBlockingErrors(changed, "keep").length, 0);
});

test("cannot split one store's nine references, or accept overlapping boxes", () => {
  const pallet = makePallet(10);
  for (const box of pallet.boxes.slice(0, 9)) box.store_code = "LOJA-1";
  assert.throws(() => splitMixedPallets([pallet]), /não é possível dividir/);
  const bad = makePallet(2);
  bad.boxes[1].pos_x = bad.boxes[0].pos_x;
  bad.boxes[1].pos_y = bad.boxes[0].pos_y;
  bad.boxes[1].pos_z = bad.boxes[0].pos_z;
  assert.match(validatePallet(bad).join(" "), /sobrepostas/);
});

test("resizing to a pallet below its known-weight limit fails", () => {
  const pallet = makePallet(2);
  pallet.boxes.forEach((box) => { box.weight_kg = 300; });
  assert.throws(() => applyPlanEdits([pallet], [{
    type: "resize_pallet", pallet_number: 1, size: "60x80",
  }]), /não cabem/);
});

test("dry_run branches before replacement and does not call SOC allocation", () => {
  const preview = source.indexOf("if (dryRun) {", source.indexOf("const palletPayload"));
  const replacement = source.indexOf('"replace_pallet_plan_with_choice"', preview);
  assert.ok(preview > 0 && replacement > preview);
  assert.doesNotMatch(
    source.slice(preview, source.indexOf("if (body.preview_digest", preview)),
    /\.rpc\(|generate_soc_code|replace_pallet_plan_atomic/,
  );
});
// ── Camadas planas (loiça frágil) ──
function item(n, boxes, l, w, h, extra = {}) {
  return {
    order_line_id: `L${n}`, line_number: n, article_code: `A${n}`, description: null,
    lg_code: extra.lg ?? "LG100", lg_num: extra.lgNum ?? 100, store_code: extra.store ?? "650",
    boxes, spec: { l, w, h, pieces_per_box: 6, estimated: false, weight_kg: extra.kg ?? 8 },
  };
}

function layersOf(pallet) {
  const byLayer = new Map();
  for (const b of pallet.boxes) {
    if (!byLayer.has(b.layer)) byLayer.set(b.layer, []);
    byLayer.get(b.layer).push(b);
  }
  return [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(([, boxes]) => boxes);
}

function assertFlatNoTowers(pallet) {
  const base = pallet.size.length * pallet.size.width;
  const layers = layersOf(pallet);
  layers.forEach((boxes, index) => {
    const zs = new Set(boxes.map((b) => b.pos_z));
    assert.equal(zs.size, 1, `camada ${index + 1} não está toda à mesma altura`);
    const area = boxes.reduce((s, b) => s + b.box_l * b.box_w, 0);
    if (index < layers.length - 1) {
      assert.ok(area / base >= 0.5, `camada ${index + 1} com ${Math.round(100 * area / base)}% tem caixas por cima (torre)`);
    }
  });
  assert.equal(validatePallet(pallet).join('; '), '');
}

test("uma referência: camadas completas e niveladas, todas as caixas iguais por camada", () => {
  const pallet = packPallet(sizes[1], [item(1, 40, 400, 300, 250)]);
  assert.equal(pallet.boxes.length, 40);
  assertFlatNoTowers(pallet);
  const layers = layersOf(pallet);
  // 1200x800 leva 8 caixas 400x300 por camada
  assert.ok(layers.slice(0, -1).every((l) => l.length === 8));
  for (const l of layers) assert.equal(new Set(l.map((b) => b.box_h)).size, 1);
});

test("alturas diferentes não se misturam na mesma camada (sem degraus)", () => {
  const pallet = packPallet(sizes[1], [item(1, 16, 400, 300, 300), item(2, 16, 400, 300, 200)]);
  assert.equal(pallet.boxes.length, 32);
  assertFlatNoTowers(pallet);
  for (const l of layersOf(pallet)) assert.equal(new Set(l.map((b) => b.box_h)).size, 1);
});

test("poucas caixas de vários tamanhos ficam numa só camada, sem torre", () => {
  const pallet = packPallet(sizes[1], [
    item(1, 2, 400, 300, 300), item(2, 2, 300, 300, 200), item(3, 1, 500, 400, 350),
  ]);
  assert.equal(pallet.boxes.length, 5);
  assert.equal(pallet.layers, 1);
  assertFlatNoTowers(pallet);
});

function touching(a, b) {
  const sameZ = a.pos_z === b.pos_z;
  const xTouch = a.pos_x + a.box_l === b.pos_x || b.pos_x + b.box_l === a.pos_x;
  const yTouch = a.pos_y + a.box_w === b.pos_y || b.pos_y + b.box_w === a.pos_y;
  const xOver = a.pos_x < b.pos_x + b.box_l && b.pos_x < a.pos_x + a.box_l;
  const yOver = a.pos_y < b.pos_y + b.box_w && b.pos_y < a.pos_y + a.box_w;
  return sameZ && ((xTouch && yOver) || (yTouch && xOver));
}

function connected(boxes) {
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const i = queue.pop();
    boxes.forEach((b, j) => {
      if (!seen.has(j) && touching(boxes[i], b)) { seen.add(j); queue.push(j); }
    });
  }
  return seen.size === boxes.length;
}

test("caixas do mesmo artigo ficam juntas (encostadas) na camada", () => {
  const pallet = packPallet(sizes[1], [item(1, 4, 400, 300, 250), item(2, 4, 400, 300, 250, { store: "651" })]);
  const first = layersOf(pallet)[0];
  assert.ok(connected(first.filter((b) => b.article_code === "A1")), "A1 separadas");
  assert.ok(connected(first.filter((b) => b.article_code === "A2")), "A2 separadas");
});

test("sem espaços no meio: as caixas de cada camada estão todas encostadas", () => {
  const pallet = packPallet(sizes[0], [
    item(1, 2, 300, 290, 280), item(2, 2, 430, 410, 290, { lg: "LG90", lgNum: 90 }),
    item(3, 2, 280, 260, 290, { lg: "LG80", lgNum: 80 }),
  ]);
  for (const layer of layersOf(pallet)) {
    const base = layer.filter((b) => b.pos_z === layer[0].pos_z);
    assert.ok(connected(base), "há caixas soltas com espaço no meio");
  }
  assertFlatNoTowers(pallet);
});

test("nunca se empilha sobre uma camada pequena: o resto fica para outra palete", () => {
  // 3 caixas altas (cobrem 37%) + muitas baixas que não cabem ao lado
  const queue = [item(1, 3, 400, 400, 600), item(2, 30, 600, 400, 150)];
  const pallet = packPallet(sizes[1], queue);
  assertFlatNoTowers(pallet);
});

test("regra do caracol: a camada começa no canto da frente e segue pela borda", () => {
  const pallet = packPallet(sizes[1], [item(1, 8, 400, 300, 250)]);
  const first = layersOf(pallet)[0].sort((a, b) => a.placement_sequence - b.placement_sequence);
  assert.equal(first[0].pos_x, 0);
  assert.equal(first[0].pos_y, 0);
  // as primeiras caixas vão ao longo da frente (y = 0), da esquerda para a direita
  assert.equal(first[1].pos_y, 0);
  assert.ok(first[1].pos_x > first[0].pos_x);
  // não há caixas no meio antes de a borda estar ocupada
  const lastEdge = first.findIndex((b) => b.pos_x > 0 && b.pos_y > 0 &&
    b.pos_x + b.box_l < 1200 && b.pos_y + b.box_w < 800);
  assert.ok(lastEdge === -1 || lastEdge >= 4);
});

test("regra dos LG: com caixas iguais, o LG mais alto fica sempre em baixo", () => {
  const pallet = packPallet(sizes[1], [
    item(2, 12, 400, 300, 250, { lg: "LG100", lgNum: 100 }),
    item(1, 12, 400, 300, 250, { lg: "LG200", lgNum: 200 }),
  ]);
  assertFlatNoTowers(pallet);
  const highestLow = Math.max(...pallet.boxes.filter((b) => b.lg_code === "LG200").map((b) => b.layer));
  const lowestHigh = Math.min(...pallet.boxes.filter((b) => b.lg_code === "LG100").map((b) => b.layer));
  assert.ok(highestLow <= lowestHigh, "há LG100 por baixo de LG200");
  assert.equal(layersOf(pallet)[0].every((b) => b.lg_code === "LG200"), true);
});
