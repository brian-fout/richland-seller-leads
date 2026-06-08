const PARCEL =
  "https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0";

async function query(where, fields = "PARCEL_ID,SITUS_ADDRESS,OWNER_NAME") {
  const url = `${PARCEL}/query?where=${encodeURIComponent(where)}&outFields=${fields}&returnGeometry=false&f=json&resultRecordCount=5`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const j = await r.json();
  if (j.error) return { error: j.error };
  return { count: j.features?.length ?? 0, attrs: j.features?.map((f) => f.attributes) ?? [] };
}

async function layerInfo() {
  const r = await fetch(`${PARCEL}?f=json`, { signal: AbortSignal.timeout(25000) });
  return r.json();
}

const info = await layerInfo();
console.log("layer fields sample:", info.fields?.slice(0, 20).map((f) => f.name).join(", "));
console.log(
  "address-ish fields:",
  info.fields?.filter((f) => /addr|situs|parcel|owner|location/i.test(f.name)).map((f) => f.name)
);

console.log("\nby parcel:", await query("PARCEL_ID='027-06-078-13-001'"));
console.log("\nprobate addr:", await query("UPPER(SITUS_ADDRESS) LIKE '%1150%AVERILL%'"));
console.log("\neviction addr:", await query("UPPER(SITUS_ADDRESS) LIKE '%208%STURGES%'"));
console.log("\noak lot:", await query("UPPER(SITUS_ADDRESS) LIKE '%630 OAK%'"));
