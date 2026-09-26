import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Local-only regression example; no Supabase client, SQL, or HTTP is used.
const source = await readFile(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8",
);

const lineId = "line-1";
const storeCode = "STORE-42";
const asnNumber = "ASN-100";
const asnItemNum = "10";
const legacyFixture = {
  quantityCases: 4,
  plans: [
    { id: "PALLET-1", socCode: "SOC000001", hasStoreContainers: false },
    { id: "PALLET-2", socCode: "SOC000002", hasStoreContainers: false },
  ],
  containers: [],
  palletItems: [
    { planId: "PALLET-1", lineId, storeCode, boxNumber: 1 },
    { planId: "PALLET-1", lineId, storeCode, boxNumber: 1 },
    { planId: "PALLET-1", lineId, storeCode, boxNumber: 1 },
    { planId: "PALLET-2", lineId, storeCode, boxNumber: 1 },
  ],
};

const containerFixture = {
  quantityCases: 4,
  plans: [
    { id: "PALLET-C1", socCode: null, hasStoreContainers: true },
    { id: "PALLET-C2", socCode: null, hasStoreContainers: true },
  ],
  containers: [
    { planId: "PALLET-C1", storeCode, socCode: "SOC000101" },
    { planId: "PALLET-C2", storeCode, socCode: "SOC000102" },
  ],
  palletItems: [
    { planId: "PALLET-C1", lineId, storeCode, boxNumber: 1 },
    { planId: "PALLET-C1", lineId, storeCode, boxNumber: 1 },
    { planId: "PALLET-C1", lineId, storeCode, boxNumber: 1 },
    { planId: "PALLET-C2", lineId, storeCode, boxNumber: 1 },
  ],
};

function getSocCode(fixture, item, planById, socByPlanStore) {
  const plan = planById.get(item.planId);
  return plan.hasStoreContainers
    ? socByPlanStore.get(`${item.planId}|${item.storeCode}`)
    : plan.socCode;
}

function buildDlCountsBefore(fixture) {
  // Mirrors the previous implementation: legacy plan SOC assignment replaced
  // an existing count, while container-backed plans summed box_number.
  const counts = new Map();
  const planById = new Map(fixture.plans.map((plan) => [plan.id, plan]));
  const socByPlanStore = new Map(
    fixture.containers.map((container) => [
      `${container.planId}|${container.storeCode}`,
      container.socCode,
    ]),
  );

  for (const item of fixture.palletItems) {
    const plan = planById.get(item.planId);
    const socCode = getSocCode(fixture, item, planById, socByPlanStore);
    const key = `${item.lineId}|${socCode}`;
    if (plan.hasStoreContainers) {
      counts.set(key, (counts.get(key) || 0) + Math.max(1, item.boxNumber || 1));
    } else {
      counts.set(key, Math.max(1, item.boxNumber || 1));
    }
  }
  return counts;
}

function buildDlCountsAfter(fixture) {
  // New rule: one increment per matching pallet_items row, keyed by line+SOC.
  const counts = new Map();
  const planById = new Map(fixture.plans.map((plan) => [plan.id, plan]));
  const socByPlanStore = new Map(
    fixture.containers.map((container) => [
      `${container.planId}|${container.storeCode}`,
      container.socCode,
    ]),
  );

  for (const item of fixture.palletItems) {
    const socCode = getSocCode(fixture, item, planById, socByPlanStore);
    const key = `${item.lineId}|${socCode}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function dlValues(fixture, counts) {
  const planById = new Map(fixture.plans.map((plan) => [plan.id, plan]));
  const socByPlanStore = new Map(
    fixture.containers.map((container) => [
      `${container.planId}|${container.storeCode}`,
      container.socCode,
    ]),
  );
  return [...new Set(fixture.palletItems.map((item) =>
    getSocCode(fixture, item, planById, socByPlanStore)
  ))].sort().map((socCode) => ({
    socCode,
    dl11: counts.get(`${lineId}|${socCode}`),
  }));
}

function serializeSyntheticDesadv(dlEntries, dg18) {
  const dgFields = Array(29).fill("");
  dgFields[0] = "DG";
  dgFields[18] = String(dg18);
  const dlLines = dlEntries.map((dl) => {
    const fields = Array(12).fill("");
    fields[0] = "DL";
    fields[2] = storeCode;
    fields[6] = asnItemNum;
    fields[7] = "1.000";
    fields[8] = "UN";
    fields[9] = asnNumber;
    fields[10] = dl.socCode;
    fields[11] = String(dl.dl11);
    return fields.join(";");
  });
  return [dgFields.join(";"), ...dlLines];
}

function assertSerializedCounts(records, dlEntries, dg18) {
  assert.equal(records[0].split(";").length, 29);
  assert.equal(records[0].split(";")[18], String(dg18));
  assert.deepEqual(
    records.slice(1).map((record) => record.split(";").length),
    dlEntries.map(() => 12),
  );
  assert.deepEqual(
    records.slice(1).map((record) => record.split(";")[11]),
    dlEntries.map((dl) => String(dl.dl11)),
  );
}

const legacyBeforeDl = dlValues(legacyFixture, buildDlCountsBefore(legacyFixture));
const legacyAfterDl = dlValues(legacyFixture, buildDlCountsAfter(legacyFixture));
const legacyBeforeDg18 = String(legacyFixture.quantityCases);
const legacyAfterDg18 = String(legacyAfterDl.reduce((sum, dl) => sum + dl.dl11, 0));
assert.deepEqual(legacyBeforeDl, [
  { socCode: "SOC000001", dl11: 1 },
  { socCode: "SOC000002", dl11: 1 },
]);
assert.deepEqual(legacyAfterDl, [
  { socCode: "SOC000001", dl11: 3 },
  { socCode: "SOC000002", dl11: 1 },
]);
assert.equal(legacyBeforeDg18, "4");
assert.equal(legacyAfterDg18, "4");
assertSerializedCounts(
  serializeSyntheticDesadv(legacyBeforeDl, legacyBeforeDg18),
  legacyBeforeDl,
  legacyBeforeDg18,
);
assertSerializedCounts(
  serializeSyntheticDesadv(legacyAfterDl, legacyAfterDg18),
  legacyAfterDl,
  legacyAfterDg18,
);

assert.equal(containerFixture.plans.every((plan) => plan.hasStoreContainers), true);
assert.equal(containerFixture.containers.length, 2);
assert.equal(containerFixture.palletItems.length, 4);
assert.equal(containerFixture.palletItems.every((item) => item.boxNumber === 1), true);
const containerBeforeDl = dlValues(
  containerFixture,
  buildDlCountsBefore(containerFixture),
);
const containerAfterDl = dlValues(
  containerFixture,
  buildDlCountsAfter(containerFixture),
);
const containerBeforeDg18 = String(containerFixture.quantityCases);
const containerAfterDg18 = String(
  containerAfterDl.reduce((sum, dl) => sum + dl.dl11, 0),
);
assert.deepEqual(containerBeforeDl, [
  { socCode: "SOC000101", dl11: 3 },
  { socCode: "SOC000102", dl11: 1 },
]);
assert.deepEqual(containerAfterDl, [
  { socCode: "SOC000101", dl11: 3 },
  { socCode: "SOC000102", dl11: 1 },
]);
assert.equal(containerBeforeDg18, "4");
assert.equal(containerAfterDg18, "4");
assertSerializedCounts(
  serializeSyntheticDesadv(containerBeforeDl, containerBeforeDg18),
  containerBeforeDl,
  containerBeforeDg18,
);
assertSerializedCounts(
  serializeSyntheticDesadv(containerAfterDl, containerAfterDg18),
  containerAfterDl,
  containerAfterDg18,
);

// Guard the actual function implementation as well as the deterministic sample.
assert.match(
  source,
  /palletItemCountByLineSoc\.set\(\s*lineSocKey,\s*\(palletItemCountByLineSoc\.get\(lineSocKey\) \|\| 0\) \+ 1/s,
);
assert.match(
  source,
  /dgFields\[18\]\s*=\s*String\(\s*dg\.dlEntries\.reduce\(\(sum, dl\) => sum \+ dl\.palletItemCount, 0\)\s*,?\s*\)/s,
);
assert.match(source, /dlFields\[11\]\s*=\s*String\(dl\.palletItemCount\)/);

console.log("Legacy fixture before:");
for (const record of serializeSyntheticDesadv(legacyBeforeDl, legacyBeforeDg18)) {
  console.log(record);
}
console.log("Legacy fixture after:");
for (const record of serializeSyntheticDesadv(legacyAfterDl, legacyAfterDg18)) {
  console.log(record);
}
console.log("Container-backed fixture before (synthetic DESADV records):");
for (const record of serializeSyntheticDesadv(containerBeforeDl, containerBeforeDg18)) {
  console.log(record);
}
console.log("Container-backed fixture after (synthetic DESADV records):");
for (const record of serializeSyntheticDesadv(containerAfterDl, containerAfterDg18)) {
  console.log(record);
}
console.log("PASS: pallet-item counts and DG[18] totals match both fixtures.");