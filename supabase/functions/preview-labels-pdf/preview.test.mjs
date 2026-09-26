import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const preview = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const issuer = readFileSync(new URL("../generate-labels-pdf/index.ts", import.meta.url), "utf8");
const page = readFileSync(new URL(
  "../../../artifacts/paletizacao-edi/src/pages/LabelsPage.tsx", import.meta.url,
), "utf8");

test("preview has no issuance or database/storage writes, even without a SOC", () => {
  assert.doesNotMatch(preview, /\.rpc\s*\(|\.(?:insert|update|upsert|delete|upload|remove)\s*\(/);
  assert.match(preview, /const missingSoc = "SOC POR EMITIR"/);
  assert.match(preview, /createLabelsPdf\(labels, true\)/);
  assert.match(issuer, /if \(import\.meta\.main\) Deno\.serve/);
  assert.match(issuer, /"PRÉ-VISUALIZAÇÃO"/);
});

test("preview button cannot fall back to issuance and does not change order state", () => {
  const handler = page.split("const handlePreviewPdf =")[1]?.split("const handleIssuePdf =")[0];
  assert.ok(handler, "preview handler not found");
  assert.match(handler, /invoke<Blob>\('preview-labels-pdf'/);
  assert.doesNotMatch(handler, /generate-labels-pdf|setOrders|fetchData/);
  const issue = page.split("const handleIssuePdf =")[1]?.split("const handleDownloadZpl =")[0];
  assert.ok(issue, "PDF issuance handler not found");
  assert.match(issue, /confirmIssuance\(order, 'pdf', mode\)/);
  assert.match(issue, /invoke<FnResponse>\('generate-labels-pdf'/);
});