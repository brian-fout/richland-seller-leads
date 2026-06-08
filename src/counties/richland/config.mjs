/**
 * Richland County, Ohio — county-specific URLs, vendors, and identifiers.
 * Everything here is Richland-only. Shared logic lives under src/core/ and src/arv/.
 */

export const RICHLAND_COUNTY = {
  id: "richland",
  name: "Richland County",
  state: "OH",
  fips: "39139",
  seat: "Mansfield",

  parcelIdPattern: /^\d{3}-\d{2}-\d{3}-\d{2}-\d{3}$/,
  parcelKeyLength: 13,

  gis: {
    parcelCamaLayer:
      "https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0",
    siteBase: "https://maps.richlandcountyoh.us",
  },

  auditor: {
    camaPage: "https://www.richlandcountyoh.gov/departments/auditor/CamaData",
    camaDriveFolder: "https://drive.google.com/drive/folders/1MylkuKvxVIUXKwyX5wogy6TSzD84Ihev",
    camaRequiredFiles: ["OWNDATMAX.DAT", "ASMT.DAT", "PARDAT.DAT", "SALES.DAT", "DWELL.DAT"],
  },

  beacon: {
    appId: "1067",
    layerId: "25465",
    searchPageId: "10347",
    searchPageTypeId: "2",
    detailPageId: "10349",
    detailPageTypeId: "4",
    searchUrl:
      "https://beacon.schneidercorp.com/Application.aspx?AppID=1067&LayerID=25465&PageTypeID=2&PageID=10347",
  },

  recorder: {
    kofileBase: "https://countyfusion13.kofiletech.us/countyweb",
    kofileCounty: "RichlandOH",
  },

  sheriff: {
    realAuctionBase: "https://richland.sheriffsaleauction.ohio.gov",
    countySalesPage: "https://www.richlandcountyoh.gov/sheriffsales",
  },

  /** Distress lead sources implemented for Richland (scripts/richland/). */
  leadSources: [
    "tax-liens",
    "clerk-foreclosures",
    "lis-pendens",
    "pre-foreclosure",
    "probate-estates",
    "evictions",
    "code-violations",
    "sheriff-sales",
  ],

  arv: {
    market: "mansfield",
    defaultRadiusMi: 0.5,
    defaultLookbackMonths: 18,
  },
};

export default RICHLAND_COUNTY;
