const pid = process.argv[2] ?? "027-04-044-07-000";
const params = new URLSearchParams({
  where: `PARCEL_ID='${pid}'`,
  outFields: "*",
  f: "json",
});
const url = `https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0/query?${params}`;
const j = await fetch(url).then((r) => r.json());
const a = j.features?.[0]?.attributes ?? {};
const pick = {};
for (const k of Object.keys(a).sort()) {
  if (/style|neigh|muni|class|cond|grade|use|desc|str|living|res/i.test(k)) pick[k] = a[k];
}
console.log(JSON.stringify(pick, null, 2));
