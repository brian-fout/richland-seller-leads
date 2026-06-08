/**
 * Richland Clerk eAccess (CourtView) case search helpers.
 */

import * as cheerio from "cheerio";

export function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCaseNumber(value) {
  const text = clean(value);
  const m = text.match(/(\d{4})\s*CV\s*(\d+)/i);
  if (!m) return text || null;
  return `${m[1]} CV ${m[2]}`;
}

export function isForeclosureRecord(record) {
  const hay = [
    record.case_style,
    record.case_type,
    record.case_subtype,
    record.case_category,
    record.case_description,
    record.plaintiff,
    record.defendant,
  ]
    .filter(Boolean)
    .join(" ");
  return /foreclos/i.test(hay);
}

function mergeClerkRecord(existing, raw) {
  const merged = { ...existing };
  for (const key of [
    "case_style",
    "file_date",
    "case_type",
    "case_subtype",
    "case_category",
    "case_description",
    "status",
    "detail_url",
    "plaintiff",
    "defendant",
  ]) {
    if (!merged[key] && raw[key]) merged[key] = raw[key];
  }
  if (raw.party_type === "PLAINTIFF" && raw.party_name) merged.plaintiff = raw.party_name;
  if (raw.party_type === "DEFENDANT" && raw.party_name) merged.defendant = raw.party_name;
  if (!merged.case_style && merged.plaintiff && merged.defendant) {
    merged.case_style = `${merged.plaintiff} v ${merged.defendant}`;
  } else if (!merged.case_style && merged.defendant) {
    merged.case_style = merged.defendant;
  }
  return merged;
}

export function parseSearchResults(html, pageUrl) {
  const $ = cheerio.load(html);
  const byCase = new Map();

  function pushRecord(raw) {
    const caseNumber = normalizeCaseNumber(raw.case_number);
    if (!caseNumber || !/\d{4}\s*CV\s*\d+/i.test(caseNumber)) return;

    const record = {
      source: "richland_clerk",
      case_number: caseNumber,
      case_style: raw.case_style ?? null,
      file_date: raw.file_date ?? null,
      case_type: raw.case_type ?? null,
      case_subtype: raw.case_subtype ?? null,
      case_category: raw.case_category ?? null,
      case_description: raw.case_description ?? null,
      status: raw.status ?? null,
      detail_url: raw.detail_url ?? null,
      plaintiff: raw.plaintiff ?? null,
      defendant: raw.defendant ?? null,
      party_type: raw.party_type ?? null,
      party_name: raw.party_name ?? null,
    };

    if (byCase.has(caseNumber)) {
      byCase.set(caseNumber, mergeClerkRecord(byCase.get(caseNumber), record));
      return;
    }
    byCase.set(caseNumber, record);
  }

  $("table").each((_, table) => {
    const headers = [];
    $(table)
      .find("tr")
      .first()
      .find("th, td")
      .each((__, cell) => headers.push(clean($(cell).text()).toLowerCase()));

    if (headers.length < 2) return;
    const hasCase = headers.some((h) => /case|number|style|file|type|status/.test(h));
    if (!hasCase) return;

    $(table)
      .find("tr")
      .slice(1)
      .each((__, row) => {
        const cells = $(row)
          .find("td")
          .map((___, td) => clean($(td).text()))
          .get();
        if (cells.length < 2) return;

        const rowObj = {};
        headers.forEach((h, i) => {
          if (cells[i]) rowObj[h] = cells[i];
        });

        const link = $(row)
          .find('a[href*="case.page"], a[href*="CaseDetail"], a[href*="caseDetail"], a[id*="grid~row"]')
          .first();
        const href = link.attr("href");
        const partyName = rowObj["party/company"] || rowObj.party || rowObj.company || null;
        const partyType = rowObj["party type"] || rowObj["party type"] || null;

        pushRecord({
          case_number:
            clean(link.text()) ||
            rowObj["case number"] ||
            rowObj.case ||
            rowObj.number ||
            cells.find((c) => /\d{4}\s*CV\s*\d+/i.test(c)) ||
            cells[0],
          case_style: rowObj["case style"] || rowObj.style || rowObj.title || null,
          file_date:
            rowObj["file date"] ||
            rowObj["filing date"] ||
            rowObj.filed ||
            cells.find((c) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) ||
            null,
          case_type: rowObj["case type"] || rowObj.type || null,
          case_subtype: rowObj.subtype || rowObj["case subtype"] || null,
          case_category: rowObj.category || rowObj["case category"] || null,
          case_description:
            rowObj["initiating action"] || rowObj.description || rowObj.action || null,
          status: rowObj["case status"] || rowObj.status || cells[cells.length - 1] || null,
          detail_url: href ? new URL(href, pageUrl).href : null,
          party_name: partyName,
          party_type: partyType,
          plaintiff: partyType === "PLAINTIFF" ? partyName : null,
          defendant: partyType === "DEFENDANT" ? partyName : null,
        });
      });
  });

  $("a[href*='case.page'], a[href*='CaseDetail'], a[href*='caseDetail'], a[id*='grid~row']").each((_, link) => {
    const text = clean($(link).text());
    if (!/\d{4}\s*CV\s*\d+/i.test(text)) return;
    const row = $(link).closest("tr");
    const cells = row
      .find("td")
      .map((__, td) => clean($(td).text()))
      .get();
    pushRecord({
      case_number: text,
      case_style: cells.find((c) => c !== text && !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) ?? null,
      file_date: cells.find((c) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) ?? null,
      detail_url: $(link).attr("href") ? new URL($(link).attr("href"), pageUrl).href : null,
    });
  });

  return [...byCase.values()].map(({ party_type, party_name, ...record }) => record);
}

export async function openSearchArea(page, baseUrl) {
  for (const sel of ['a:has-text("Search")', 'a[href*="search.page"]', "#searchLink"]) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      await loc.click().catch(() => null);
      await page.waitForLoadState("domcontentloaded").catch(() => null);
      await page.waitForTimeout(1500);
      if (/search|case|filing/i.test(await page.innerText("body"))) return;
    }
  }
  await page.goto(`${baseUrl}/search.page`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1500);
}

export async function openCaseTypeSearch(page) {
  const tab = page.locator('#searchPageTabSection a:has-text("Case Type")').first();
  if (!(await tab.isVisible().catch(() => false))) {
    throw new Error('Could not find "Case Type" search tab on clerk site');
  }
  await tab.click();
  await page.waitForTimeout(2000);
  const beginDate = page.locator('input[name="fileDateRange:dateInputBegin"]:visible');
  await beginDate.waitFor({ state: "visible", timeout: 20000 });
}

async function setResultsPageSize(page, sizeLabel = "75") {
  const pageSize = page.locator('select[name="topSearchPanel:pageSize"]');
  if (await pageSize.isVisible().catch(() => false)) {
    await pageSize.selectOption({ label: sizeLabel }).catch(() => null);
    await page.waitForTimeout(500);
  }
}

async function fillMaskedDateInput(page, selector, date) {
  const input = page.locator(selector);
  await input.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(600);

  await input.fill(date);
  let value = await input.inputValue();

  if (value !== date) {
    await input.click({ clickCount: 3 });
    await input.fill("");
    await input.pressSequentially(date.replace(/\D/g, ""), { delay: 35 });
    value = await input.inputValue();
  }

  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    throw new Error(`Could not enter date ${date} — field shows "${value}"`);
  }

  await input.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(400);
}

async function selectCivilCaseType(page) {
  const caseType = page.locator('select[name="caseCd"]:visible');
  await caseType.waitFor({ state: "visible", timeout: 10000 });
  await caseType.selectOption({ label: "CIVIL" }).catch(async () => {
    const selected = await caseType.evaluate((sel) => {
      const opt = [...sel.options].find((o) => /^CIVIL$/i.test(o.text.trim()));
      if (!opt) return false;
      for (const option of sel.options) option.selected = false;
      opt.selected = true;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    if (!selected) throw new Error('Could not select "CIVIL" in Case Type list');
  });
  await page.waitForTimeout(800);
}

async function readSearchValidationErrors(page) {
  return page.locator(".feedbackPanelERROR span, .feedbackPanelERROR").allTextContents();
}

export async function submitCaseTypeSearch(page, fromDate, toDate, { includeAllCivil = false } = {}) {
  await openCaseTypeSearch(page);
  await setResultsPageSize(page);

  await fillMaskedDateInput(page, 'input[name="fileDateRange:dateInputBegin"]:visible', fromDate);
  await fillMaskedDateInput(page, 'input[name="fileDateRange:dateInputEnd"]:visible', toDate);

  if (!includeAllCivil) {
    await selectCivilCaseType(page);
  }

  const searchBtn = page
    .locator(
      'form:has(input[name="fileDateRange:dateInputBegin"]) input[type="submit"][value="Search"]:visible, #caseTypeSearch input[type="submit"]:visible'
    )
    .first();
  if (!(await searchBtn.isVisible().catch(() => false))) {
    throw new Error("Could not find Search button on clerk Case Type form");
  }

  await Promise.all([
    page.waitForURL(/searchresults\.page/i, { timeout: 90000 }).catch(() => null),
    searchBtn.click(),
  ]);
  await page.waitForTimeout(2500);

  const errors = (await readSearchValidationErrors(page)).map((t) => t.trim()).filter(Boolean);
  if (errors.length) {
    throw new Error(`Clerk search rejected form: ${errors.join("; ")}`);
  }
}

/** @deprecated alias */
export const submitFilingDateSearch = submitCaseTypeSearch;

export async function collectAllSearchResults(page) {
  const records = [];
  const seenPages = new Set();

  while (true) {
    const marker = await page.locator(".navigatorLabel").innerText().catch(() => page.url());
    if (seenPages.has(marker)) break;
    seenPages.add(marker);

    const html = await page.content();
    records.push(...parseSearchResults(html, page.url()));

    const next = page.locator('a[title="Go to next page"]').first();
    if (!(await next.isVisible().catch(() => false))) break;

    await next.click();
    await page.waitForTimeout(2500);
  }

  const byCase = new Map();
  for (const record of records) {
    if (byCase.has(record.case_number)) {
      byCase.set(record.case_number, mergeClerkRecord(byCase.get(record.case_number), record));
    } else {
      byCase.set(record.case_number, record);
    }
  }
  return [...byCase.values()];
}

export function countResultsHint(body, html) {
  const m =
    body.match(/returning\s+\d+\s+of\s+(\d+)\s+records?/i) ||
    body.match(/\b(\d+)\s+cases?\s+(?:were\s+)?found/i) ||
    body.match(/\b(\d+)\s+records?\s+(?:were\s+)?found/i) ||
    body.match(/\b(\d+)\s+matches?\s+(?:were\s+)?found/i);
  if (m) return Number(m[1]);

  if (/no cases were found|no records were found|no matches were found|0 cases found/i.test(body)) {
    return 0;
  }

  if (/search results/i.test(body) && /case\.page|case number|\bCV\b/i.test(html)) {
    return null;
  }

  return null;
}
