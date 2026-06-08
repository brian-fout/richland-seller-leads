import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

function load(name) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Array.isArray(raw) ? raw : raw.records ?? [];
}

function summarize(name, records) {
  const addr = records.filter((r) => r.street_address || r.property_address || r.address || r.parcel_address).length;
  const parcel = records.filter((r) => r.parcel_id).length;
  return { name, count: records.length, with_address: addr, with_parcel_id: parcel };
}

const sources = [
  ["tax-liens", "tax-lien-list-10-21-2025.json"],
  ["probate", "probate-estates-canonical.json"],
  ["evictions", "evictions-canonical.json"],
  ["code-violations", "code-violations-canonical.json"],
  ["sheriff", "pre-foreclosure-2026-06-06.json"],
  ["lis-pendens", "lis-pendens-canonical.json"],
  ["clerk-foreclosures", "clerk-foreclosures-canonical.json"],
];

for (const [name, file] of sources) {
  const recs = load(file);
  console.log(recs ? summarize(name, recs) : { name, missing: file });
}
