/**
 * Import tax lien list CSV into SQLite.
 *
 * Usage: node scripts/import-csv-to-sqlite.mjs [path-to.csv] [path-to.db]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.join(
  __dirname,
  "..",
  "data",
  "tax-lien-list-10-21-2025.csv"
);
const DEFAULT_DB = path.join(__dirname, "..", "data", "richland-leads.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'tax_lien_list',
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS parcels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  district_code TEXT,
  district_name TEXT,
  parcel_id TEXT NOT NULL,
  stub TEXT,
  owner_name TEXT,
  mailing_address TEXT,
  street_address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  legal_description TEXT,
  acres REAL,
  prior_delq REAL,
  land_value REAL,
  building_value REAL,
  total_value REAL,
  cert_status TEXT,
  delinquent_year INTEGER,
  payment_plan TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parcel_id, stub)
);

CREATE INDEX IF NOT EXISTS idx_parcels_district_code ON parcels(district_code);
CREATE INDEX IF NOT EXISTS idx_parcels_city ON parcels(city);
CREATE INDEX IF NOT EXISTS idx_parcels_delinquent_year ON parcels(delinquent_year);
CREATE INDEX IF NOT EXISTS idx_parcels_prior_delq ON parcels(prior_delq);
CREATE INDEX IF NOT EXISTS idx_parcels_status ON parcels(status);
CREATE INDEX IF NOT EXISTS idx_parcels_owner_name ON parcels(owner_name);
`;

function emptyToNull(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function toNumber(value) {
  const n = parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toInt(value) {
  const n = parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

function importCsv(csvPath, dbPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const rows = parse(fs.readFileSync(csvPath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const db = initDb(dbPath);

  const insertImport = db.prepare(`
    INSERT INTO imports (source_file, source_type, row_count)
    VALUES (?, 'tax_lien_list', ?)
  `);

  const upsertParcel = db.prepare(`
    INSERT INTO parcels (
      import_id, district_code, district_name, parcel_id, stub,
      owner_name, mailing_address, street_address, city, state, zip,
      legal_description, acres, prior_delq, land_value, building_value,
      total_value, cert_status, delinquent_year, payment_plan
    ) VALUES (
      @import_id, @district_code, @district_name, @parcel_id, @stub,
      @owner_name, @mailing_address, @street_address, @city, @state, @zip,
      @legal_description, @acres, @prior_delq, @land_value, @building_value,
      @total_value, @cert_status, @delinquent_year, @payment_plan
    )
    ON CONFLICT(parcel_id, stub) DO UPDATE SET
      import_id = excluded.import_id,
      district_code = excluded.district_code,
      district_name = excluded.district_name,
      owner_name = excluded.owner_name,
      mailing_address = excluded.mailing_address,
      street_address = excluded.street_address,
      city = excluded.city,
      state = excluded.state,
      zip = excluded.zip,
      legal_description = excluded.legal_description,
      acres = excluded.acres,
      prior_delq = excluded.prior_delq,
      land_value = excluded.land_value,
      building_value = excluded.building_value,
      total_value = excluded.total_value,
      cert_status = excluded.cert_status,
      delinquent_year = excluded.delinquent_year,
      payment_plan = excluded.payment_plan,
      updated_at = datetime('now')
  `);

  const importMany = db.transaction((records) => {
    const importResult = insertImport.run(path.basename(csvPath), records.length);
    const importId = importResult.lastInsertRowid;

    for (const row of records) {
      upsertParcel.run({
        import_id: importId,
        district_code: emptyToNull(row.district_code),
        district_name: emptyToNull(row.district_name),
        parcel_id: emptyToNull(row.parcel_id),
        stub: emptyToNull(row.stub),
        owner_name: emptyToNull(row.owner_name),
        mailing_address: emptyToNull(row.mailing_address),
        street_address: emptyToNull(row.street_address),
        city: emptyToNull(row.city),
        state: emptyToNull(row.state),
        zip: emptyToNull(row.zip),
        legal_description: emptyToNull(row.legal_description),
        acres: toNumber(row.acres),
        prior_delq: toNumber(row.prior_delq),
        land_value: toNumber(row.land_value),
        building_value: toNumber(row.building_value),
        total_value: toNumber(row.total_value),
        cert_status: emptyToNull(row.cert_status),
        delinquent_year: toInt(row.delinquent_year),
        payment_plan: emptyToNull(row.payment_plan),
      });
    }

    return importId;
  });

  const importId = importMany(rows);
  const total = db.prepare("SELECT COUNT(*) AS count FROM parcels").get().count;

  db.close();

  return { importId, importedRows: rows.length, totalParcels: total, dbPath };
}

function main() {
  const csvPath = path.resolve(process.argv[2] ?? DEFAULT_CSV);
  const dbPath = path.resolve(process.argv[3] ?? DEFAULT_DB);

  console.error(`Importing ${csvPath}`);
  console.error(`Database: ${dbPath}`);

  const result = importCsv(csvPath, dbPath);

  console.error(`Import #${result.importId}: ${result.importedRows} rows`);
  console.error(`Total parcels in DB: ${result.totalParcels}`);
}

main();
