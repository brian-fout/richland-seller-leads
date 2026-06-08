const BASE =
  "https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0/query";

async function q(label, where) {
  const url = `${BASE}?where=${encodeURIComponent(where)}&outFields=PARCEL_ID,PARCEL_ADDRESS&returnGeometry=false&f=json&resultRecordCount=3`;
  const j = await fetch(url, { signal: AbortSignal.timeout(20000) }).then((r) => r.json());
  console.log(label, j.error ?? j.features?.map((f) => f.attributes));
}

await q("parcel_id", "PARCEL_ID = '026-11-052-17-000'");
await q("like plain", "PARCEL_ADDRESS LIKE '%1150%AVERILL%'");
await q("like upper", "UPPER(PARCEL_ADDRESS) LIKE '%1150%AVERILL%'");
