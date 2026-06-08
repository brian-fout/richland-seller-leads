/**
 * @county richland — parcel + sales-event records → shared ARV engine input format.
 */

import {
  isMansfieldCity,
  isRenovatedSale,
  normalizeCity,
  resolveCondition,
  resolveGrade,
} from "./condition.mjs";

const EARTH_MI = 3958.8;

const RETAIL_CFG = {
  minRetailPrice: 35000,
  minRetailPpsf: 35,
  maxAsIsPrice: 28000,
  maxAsIsPpsf: 24,
};

function haversineMi(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(a));
}

function bathCount(rec) {
  const full = rec.full_bath ?? rec.baths ?? null;
  const half = rec.half_bath ?? 0;
  if (full == null) return null;
  return full + half * 0.5;
}

export function subjectFromParcel(parcel) {
  return {
    sqft: parcel.square_footage ?? null,
    beds: parcel.bedrooms ?? null,
    baths: bathCount(parcel),
    yearBuilt: parcel.year_built ?? null,
    style: parcel.style != null ? String(parcel.style) : "",
    parcel_id: parcel.parcel_id,
    address: parcel.address ?? null,
    city: parcel.city ?? null,
    lat: parcel.lat ?? null,
    lon: parcel.lon ?? null,
  };
}

export function compFromSaleEvent(rec, subject, parcelLookup) {
  const parcel = parcelLookup?.get(rec.parcel_id) ?? {};
  const price = rec.sale_price ?? rec.auditor_sale_price ?? parcel.auditor_sale_price;
  const sqft = rec.square_footage ?? parcel.square_footage;
  const lat = rec.lat ?? parcel.lat;
  const lon = rec.lon ?? parcel.lon;
  const saleDate = rec.sale_date ?? rec.auditor_sale_date ?? parcel.auditor_sale_date;
  const city = rec.city ?? parcel.city ?? null;

  if (!price || !sqft || sqft < 400) return null;
  if (subject.lat == null || lat == null) return null;

  const distance = haversineMi(subject.lat, subject.lon, lat, lon);
  const ppsf = price / sqft;
  const assessed =
    (rec.land_value ?? parcel.auditor_land_value ?? parcel.land_value ?? 0) +
    (rec.building_value ?? parcel.auditor_building_value ?? parcel.building_value ?? 0);
  const saleToAssessed = assessed > 0 ? price / assessed : null;
  const condition = resolveCondition(rec, parcel);
  const grade = resolveGrade(rec, parcel);

  return {
    price,
    sqft,
    beds: rec.bedrooms ?? parcel.bedrooms ?? null,
    baths: bathCount({ ...parcel, ...rec }),
    yearBuilt: rec.year_built ?? parcel.year_built ?? null,
    style: (rec.style ?? parcel.style) != null ? String(rec.style ?? parcel.style) : "",
    distance: Math.round(distance * 1000) / 1000,
    saleDate: saleDate ? new Date(`${saleDate}T12:00:00`) : null,
    renovated: isRenovatedSale(price, ppsf, saleToAssessed, condition, grade, RETAIL_CFG),
    address: rec.address ?? parcel.address ?? rec.parcel_id,
    parcel_id: rec.parcel_id,
    city,
    neighborhood: rec.neighborhood ?? parcel.neighborhood ?? null,
    lat,
    lon,
    condition,
    grade,
  };
}

export function saleWithinMonths(saleDate, months) {
  if (!saleDate) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const iso = saleDate instanceof Date ? saleDate.toISOString().slice(0, 10) : saleDate;
  return iso >= cutoff.toISOString().slice(0, 10);
}

export function isValidSaleCandidate(rec, subject, months = 18) {
  if (rec.parcel_id === subject.parcel_id) return false;
  const saleDate = rec.sale_date ?? rec.auditor_sale_date;
  const price = rec.sale_price ?? rec.auditor_sale_price;
  if (!saleWithinMonths(saleDate, months)) return false;
  if (!price || price < 5000) return false;
  const validity = rec.validity_code ?? rec.auditor_sale_validity_code;
  if (validity != null && validity !== 2) return false;
  return true;
}

function preferSameCityComps(comps, subjectCity, minComps = 8) {
  if (!subjectCity || comps.length < minComps) return comps;
  const want = normalizeCity(subjectCity);
  const sameCity = comps.filter((c) => normalizeCity(c.city) === want);
  return sameCity.length >= minComps ? sameCity : comps;
}

function preferLocalComps(comps, subjectParcel, parcelLookup, options = {}) {
  const minNbhd = options.minNeighborhoodComps ?? 5;
  if (subjectParcel.neighborhood != null) {
    const want = subjectParcel.neighborhood;
    const sameNbhd = comps.filter((c) => {
      const nbhd = c.neighborhood ?? parcelLookup?.get(c.parcel_id)?.neighborhood;
      return nbhd != null && nbhd === want;
    });
    if (sameNbhd.length >= minNbhd) return sameNbhd;
  }

  if (options.preferSameCity && isMansfieldCity(subjectParcel.city)) {
    return preferSameCityComps(comps, subjectParcel.city, options.minSameCityComps ?? 15);
  }

  return comps;
}

export function buildCompsForSubject(subjectParcel, saleRecords, parcelLookup, options = {}) {
  const months = options.months ?? 18;
  const maxMi = options.maxMi ?? 0.5;

  let comps = saleRecords
    .filter((rec) => isValidSaleCandidate(rec, subjectParcel, months))
    .map((rec) => compFromSaleEvent(rec, subjectParcel, parcelLookup))
    .filter((c) => c && c.distance <= maxMi + 0.001);

  comps = preferLocalComps(comps, subjectParcel, parcelLookup, options);
  return comps;
}
