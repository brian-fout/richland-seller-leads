const where = encodeURIComponent("PARCEL_ID LIKE '%027-06-078-13%'");
const url = `https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0/query?where=${where}&outFields=*&returnGeometry=false&f=json&resultRecordCount=3`;
const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
const j = await r.json();
console.log(JSON.stringify(j, null, 2));
