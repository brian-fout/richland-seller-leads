/**
 * Parse Richland County probate case detail pages (CaseLook).
 */

import * as cheerio from "cheerio";

export function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCityStateZip(text) {
  const value = clean(text);
  if (!value) return { city: null, state: null, zip: null };
  const m = value.match(/^(.+?),\s*([A-Za-z]{2})\s*(\d{5}(?:-\d{4})?)?$/);
  return {
    city: m ? clean(m[1]) : value,
    state: m?.[2]?.toUpperCase() ?? null,
    zip: m?.[3] ?? null,
  };
}

function readPartyTable($, table) {
  const fields = {};
  table.find("tr").each((_, tr) => {
    $(tr)
      .find("th.column1, th.column3")
      .each((__, th) => {
        const label = clean($(th).text()).replace(/:$/, "");
        const valueCol = $(th).hasClass("column1") ? "column2" : "column4";
        const value = clean($(tr).find(`td.${valueCol}`).first().text());
        if (label && value) fields[label] = value;
      });
  });
  return fields;
}

function readCaseField($, labelText) {
  let value = null;
  $("th.column1, th.column3").each((_, th) => {
    const label = clean($(th).text());
    if (label !== labelText) return;
    const valueCol = $(th).hasClass("column1") ? "column2" : "column4";
    value = clean($(th).closest("tr").find(`td.${valueCol}`).first().text()) || value;
  });
  return value;
}

/** Extract decedent residence and a few case fields from a case detail HTML page. */
export function parseProbateDetail(html) {
  const $ = cheerio.load(html);

  if (/CAPTCHA|captchaResponse/i.test(html) && !$("#caseInformation").length) {
    return { error: "captcha_required" };
  }
  if (/Access Denied|do not have permissions/i.test(html)) {
    return { error: "access_denied" };
  }

  const decedentHeader = $("#caseInformation h4.search")
    .filter((_, el) => /decedent/i.test($(el).text()))
    .first();
  const decedentTable = decedentHeader.length
    ? decedentHeader.closest("tr").next("tr").find(".partyContainer table").first()
    : null;

  const decedent = decedentTable?.length ? readPartyTable($, decedentTable) : {};
  const csz = parseCityStateZip(decedent["City/State/ZIP"]);

  let filingType = readCaseField($, "Filing Type:");
  const caseClosed = readCaseField($, "Case Closed:");
  const status = caseClosed ? "Closed" : "Open";

  return {
    decedent_name: decedent.Decedent ?? null,
    street_address: decedent.Address ?? null,
    city: csz.city,
    state: csz.state,
    zip: csz.zip,
    attorney: decedent.Attorney ?? null,
    filing_type: filingType,
    status,
  };
}

export function mergeProbateDetail(record, detail) {
  if (!detail || detail.error) return record;
  return {
    ...record,
    decedent_name: record.decedent_name ?? detail.decedent_name ?? null,
    street_address: detail.street_address ?? record.street_address ?? null,
    city: detail.city ?? record.city ?? null,
    state: detail.state ?? record.state ?? null,
    zip: detail.zip ?? record.zip ?? null,
    attorney: detail.attorney ?? record.attorney ?? null,
    filing_type: detail.filing_type ?? record.filing_type ?? null,
    status: detail.status ?? record.status ?? null,
  };
}

export function needsProbateDetail(record, { force = false } = {}) {
  if (!record?.detail_url) return false;
  if (force) return true;
  return !record.street_address;
}
