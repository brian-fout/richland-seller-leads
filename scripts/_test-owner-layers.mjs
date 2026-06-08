const PARCEL_ID = "027-04-044-07-000";
const LAYERS = [
  ["Parcel_CAMA", "https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0"],
  ["Tax_Parcels", "https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcels/Tax_Parcels/FeatureServer/0"],
  ["IASWOLRD_LGIM", "https://maps.richlandcountyoh.us/richlandgis/rest/services/IASWOLRD_LGIM/MapServer/30"],
];

async function queryLayer(name, base) {
  const where = `PARCEL_ID='${PARCEL_ID}' OR PARCELID='${PARCEL_ID}'`;
  const url = `${base}/query?where=${encodeURIComponent(where)}&outFields=*&returnGeometry=false&f=json&resultRecordCount=3`;
  const j = await fetch(url, { signal: AbortSignal.timeout(25000) }).then((r) => r.json());
  if (j.error) return { name, error: j.error.message || JSON.stringify(j.error) };
  const attrs = j.features?.map((f) => f.attributes) ?? [];
  return {
    name,
    count: attrs.length,
    rows: attrs.map((a) => ({
      owner: a.MAILING_NAME_1 ?? a.OWNER1 ?? a.OWNER_NAME ?? a.OWNER ?? null,
      address: a.PARCEL_ADDRESS ?? a.SITUS_ADDRESS ?? a.PARCEL_LOCATION ?? null,
      sale_date: a.SALES_DATE ?? null,
      sale_price: a.SALES_PRICE ?? null,
    })),
  };
}

for (const [name, base] of LAYERS) {
  try {
    console.log(JSON.stringify(await queryLayer(name, base), null, 2));
  } catch (err) {
    console.log(JSON.stringify({ name, error: err.cause?.code ?? err.message }));
  }
}
