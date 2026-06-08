/**
 * Richland Clerk eAccess case detail parsing and navigation.
 */

import * as cheerio from "cheerio";
import { clean } from "./clerk-search.mjs";
import { BASE_URL } from "./clerk-session.mjs";

const ADDRESS_LABELS = [
  /^property address$/i,
  /^site address$/i,
  /^situs address$/i,
  /^street address$/i,
  /^location$/i,
  /^address$/i,
];

const PARCEL_LABELS = [/^parcel(?:\s+(?:id|number|#))?$/i, /^parcel$/i, /^tax parcel$/i];

function parseCityStateZip(text) {
  const value = clean(text);
  if (!value) return { city: null, state: null, zip: null };
  const m = value.match(/^(.+?),\s*([A-Za-z]{2})\s*(\d{5}(?:-\d{4})?)?$/);
  return {
    city: m ? clean(m[1]) : value,
    state: m?.[2]?.toUpperCase() ?? null,
    zip: m?.[3] ?? null,
  };
}

function readLabelValuePairs($) {
  const fields = {};

  function setField(label, value) {
    const key = clean(label).replace(/:$/, "");
    const val = clean(value);
    if (!key || !val) return;
    fields[key.toLowerCase()] = val;
  }

  $("table").each((_, table) => {
    $(table)
      .find("tr")
      .each((__, row) => {
        const th = $(row).find("th").first();
        const td = $(row).find("td").first();
        if (th.length && td.length) setField(th.text(), td.text());

        $(row)
          .find("th")
          .each((___, header) => {
            const label = clean($(header).text());
            const valueCol = $(header).hasClass("column1") ? "column2" : "column4";
            const value = clean($(header).closest("tr").find(`td.${valueCol}`).first().text());
            if (label && value) setField(label, value);
          });
      });
  });

  $("dt").each((_, dt) => {
    const label = clean($(dt).text());
    const value = clean($(dt).next("dd").text());
    if (label && value) setField(label, value);
  });

  $("label").each((_, label) => {
    const text = clean($(label).text());
    const forId = $(label).attr("for");
    const value = forId
      ? clean($(`#${forId}`).val() || $(`#${forId}`).text())
      : clean($(label).parent().find("input, span, div.value").first().text());
    if (text && value) setField(text, value);
  });

  return fields;
}

function pickField(fields, patterns) {
  for (const [key, value] of Object.entries(fields)) {
    if (patterns.some((re) => re.test(key))) return value;
  }
  return null;
}

function extractFromBodyText(body) {
  const out = {};
  const patterns = [
    [/property address[:\s]+(.+?)(?:\n|$)/i, "property_address"],
    [/site address[:\s]+(.+?)(?:\n|$)/i, "property_address"],
    [/situs address[:\s]+(.+?)(?:\n|$)/i, "property_address"],
    [/parcel(?:\s+(?:id|number|#))?[:\s]+([\d-]+)/i, "parcel_id"],
  ];
  for (const [re, key] of patterns) {
    const m = body.match(re);
    if (m?.[1] && !out[key]) out[key] = clean(m[1]);
  }
  return out;
}

export function caseNumberSearchVariants(caseNumber) {
  const base = clean(caseNumber);
  const m = base.match(/^(\d{4}\s+CV\s+\d+)/i);
  const core = m ? m[1].toUpperCase() : base.toUpperCase();
  return [...new Set([`${core} N`, `${core} R`, core])];
}

export function parseClerkCaseDetail(html) {
  const $ = cheerio.load(html);
  const body = clean($("body").text());
  const fields = readLabelValuePairs($);
  const textHints = extractFromBodyText(body);

  let propertyAddress =
    pickField(fields, ADDRESS_LABELS) ||
    textHints.property_address ||
    null;
  let parcelId = pickField(fields, PARCEL_LABELS) || textHints.parcel_id || null;

  if (parcelId) {
    const norm = parcelId.match(/[\d-]{10,}/);
    parcelId = norm ? norm[0] : parcelId;
  }

  let city = null;
  let state = null;
  let zip = null;
  if (propertyAddress && /,/.test(propertyAddress)) {
    const csz = parseCityStateZip(propertyAddress.split(/\n/)[0]);
    propertyAddress = propertyAddress.split(",")[0].trim();
    city = csz.city;
    state = csz.state;
    zip = csz.zip;
  }

  const legalDescription =
    pickField(fields, [/^legal description$/i, /^legal$/i]) || null;

  if (/please enter letters from image|captcha/i.test(body)) {
    return { error: "captcha_required" };
  }

  return {
    property_address: propertyAddress,
    city,
    state,
    zip,
    parcel_id: parcelId,
    legal_description: legalDescription,
  };
}

export async function openClerkCaseDetail(page, caseNumber) {
  await page.goto(`${BASE_URL}/search.page`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(1500);

  for (const variant of caseNumberSearchVariants(caseNumber)) {
    const input = page.locator('input[name="caseDscr"]:visible');
    await input.waitFor({ state: "visible", timeout: 10000 });
    await input.fill(variant);

    await Promise.all([
      page.waitForURL(/searchresults\.page/i, { timeout: 60000 }).catch(() => null),
      page.locator('#caseNumberSearch input[type="submit"]:visible').click(),
    ]);
    await page.waitForTimeout(2000);

    const caseLink = page
      .locator(`a[id*="grid~row"]:has-text("${variant.split(" ").slice(0, 3).join(" ")}")`)
      .first();
    if (!(await caseLink.isVisible().catch(() => false))) continue;

    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => null),
      caseLink.click(),
    ]);
    await page.waitForTimeout(2500);

    const html = await page.content();
    const parsed = parseClerkCaseDetail(html);
    if (!parsed.error && (parsed.property_address || parsed.parcel_id)) {
      return { html, url: page.url(), detail: parsed, search_variant: variant };
    }

    if (!parsed.error && /case|detail|summary|parties/i.test(await page.innerText("body"))) {
      return { html, url: page.url(), detail: parsed, search_variant: variant };
    }
  }

  throw new Error(`Could not open case detail for ${caseNumber}`);
}

export function mergeClerkDetail(record, detail, enrichment = {}) {
  if (!detail || detail.error) return { ...record, ...enrichment };
  return {
    ...record,
    property_address: detail.property_address ?? record.property_address ?? null,
    city: detail.city ?? record.city ?? null,
    state: detail.state ?? record.state ?? "OH",
    zip: detail.zip ?? record.zip ?? null,
    legal_description: detail.legal_description ?? record.legal_description ?? null,
    parcel_id: detail.parcel_id ?? record.parcel_id ?? enrichment.parcel_id ?? null,
    ...enrichment,
  };
}

export function needsClerkEnrichment(record, { force = false } = {}) {
  if (force) return true;
  return !record.parcel_id || !record.property_address;
}
