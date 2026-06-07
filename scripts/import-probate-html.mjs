import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import { BASE_URL } from "./probate-session.mjs";
import { writeDayOutputs, writeCanonicalFromDays } from "./scrape-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "..", "data", "_probate-last-results.html"), "utf8");

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseResults(htmlText) {
  const $ = cheerio.load(htmlText);
  const records = [];
  $("#searchResults .record").each((_, rec) => {
    const caseNumber = clean($(rec).find(".fullCaseNumber").first().text());
    if (!caseNumber) return;
    const href = $(rec).find("a.caseLink").first().attr("href");
    records.push({
      source: "richland_probate",
      case_number: caseNumber,
      decedent_name:
        clean($(rec).find(".caseField.concerningName").first().text()).replace(/^Concerning:\s*/i, "") ||
        clean($(rec).find(".caseTitle .concerningName").first().text()) ||
        null,
      file_date: clean($(rec).find(".caseField.fileDate").first().text()).replace(/^Filed:\s*/i, "") || null,
      case_type:
        clean($(rec).find(".caseField.caseType").first().text()).replace(/^Case Type:\s*/i, "") || "Estate",
      status:
        clean($(rec).find(".caseField.violation").first().text()).replace(/^Viol\.\/Cause:\s*/i, "") || null,
      detail_url: href ? new URL(href, BASE_URL).href : null,
    });
  });
  return records;
}

const records = parseResults(html);
writeDayOutputs("probate-estates", "01/05/2026", records);
const { canonical, canonicalJson } = writeCanonicalFromDays("probate-estates", (r) => r.case_number);
console.log(`Imported ${records.length} record(s) for 01/05/2026`);
console.log(`Canonical total: ${canonical.length} (${canonicalJson})`);
