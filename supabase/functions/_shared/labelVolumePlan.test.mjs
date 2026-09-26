import assert from "node:assert/strict";
import test from "node:test";
import { planLabelVolumes } from "./labelVolumePlan.ts";

const socs = new Map([
  ["522", "SOC0000555"], ["534", "SOC0000550"], ["542", "SOC0000554"],
  ["651", "SOC0000551"], ["652", "SOC0000553"], ["654", "SOC0000552"],
  ["657", "SOC0000549"], ["667", "SOC0000548"], ["669", "SOC0000556"],
]);

test("8093573250: 18 labels, five store 669 boxes using the same SOC", () => {
  const groups = [
    ["522", "LG1710", 1], ["534", "LG1709", 1], ["542", "LG1708", 2],
    ["651", "LG1707", 3], ["652", "LG1706", 3], ["654", "LG1705", 1],
    ["657", "LG1704", 1], ["667", "LG1703", 1], ["669", "LG1702", 5],
  ].map(([store_code, lg_code, box_count]) => ({ store_code, lg_code, box_count }));

  for (const mode of ["pallet", "boxes"]) {
    const volumes = planLabelVolumes(groups, socs, "", mode);
    assert.equal(volumes.length, 18);
    assert.deepEqual(volumes.map((v) => v.lg_code), [...volumes.map((v) => v.lg_code)].sort((a, b) =>
      Number(b.slice(2)) - Number(a.slice(2))
    ));
    assert.deepEqual(volumes.filter((v) => v.store_code === "669").map((v) => ({
      soc: v.soc_code, no: v.volume_no, total: v.volume_total,
    })), [1, 2, 3, 4, 5].map((no) => ({ soc: "SOC0000556", no, total: 5 })));
    assert.equal(volumes.find((v) => v.store_code === "542")?.volume_total, 2);
    assert.ok(volumes.every((v) => v.box_count === null));
  }
});

test("dedicated pallet uses one label and actual box total by default", () => {
  const groups = [
    { store_code: "669", lg_code: "LG10", box_count: 3 },
    { store_code: "669", lg_code: "LG11", box_count: 2 },
  ];
  const containers = new Map([["669", "SOC0000556"]]);
  assert.deepEqual(planLabelVolumes(groups, containers, "", "pallet"), [{
    store_code: "669", lg_code: "LG11", soc_code: "SOC0000556",
    volume_no: 1, volume_total: 1, box_count: 5,
  }]);
  const boxes = planLabelVolumes(groups, containers, "", "boxes");
  assert.equal(boxes.length, 5);
  assert.deepEqual(boxes.map((v) => v.volume_no), [1, 2, 3, 4, 5]);
  assert.ok(boxes.every((v) => v.volume_total === 5 && v.soc_code === "SOC0000556"));
  assert.deepEqual(boxes.map((v) => v.lg_code), ["LG11", "LG11", "LG10", "LG10", "LG10"]);
});

test("legacy dedicated pallet can use the pallet SOC; mixed cannot", () => {
  const one = [{ store_code: "669", lg_code: "LG10", box_count: 1 }];
  assert.equal(planLabelVolumes(one, new Map(), "SOC0000556", "pallet")[0].soc_code, "SOC0000556");
  assert.throws(() => planLabelVolumes([...one, { store_code: "522", lg_code: "LG10", box_count: 1 }], new Map(), "SOC0000556", "boxes"), /mista sem SOC/);
  assert.throws(() => planLabelVolumes(one, new Map(), "", "pallet"), /sem SOC/);
});

test("volumes restart when the next pallet/SOC is planned", () => {
  const group = [{ store_code: "669", lg_code: "LG10", box_count: 2 }];
  const first = planLabelVolumes(group, new Map([["669", "SOC0000556"]]), "", "boxes");
  const second = planLabelVolumes(group, new Map([["669", "SOC0000557"]]), "", "boxes");
  assert.deepEqual(first.map((v) => v.volume_no), [1, 2]);
  assert.deepEqual(second.map((v) => v.volume_no), [1, 2]);
});