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