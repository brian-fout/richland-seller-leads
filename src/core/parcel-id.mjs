/**
 * @shared Parcel ID normalization and extraction from legal text.
 */

export function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Richland format: 027-04-044-07-000 */
export function normalizeParcelId(value) {
  const text = clean(value).toUpperCase();
  if (!text) return null;
  const m = text.match(/(\d{3}-\d{2}-\d{3}-\d{2}-\d{3})/);
  return m ? m[1] : text;
}

/** 13-digit CAMA parcel key → dashed parcel_id */
export function parcelKeyToId(parcelKey) {
  const key = clean(parcelKey).replace(/\D/g, "");
  if (key.length !== 13) return null;
  return `${key.slice(0, 3)}-${key.slice(3, 5)}-${key.slice(5, 8)}-${key.slice(8, 10)}-${key.slice(10, 13)}`;
}

/**
 * Best-effort parcel_id from recorder legal descriptions, remarks, references.
 */
export function extractParcelFromText(...parts) {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return null;

  const dashed = text.match(/\b(\d{3}-\d{2}-\d{3}-\d{2}-\d{3})\b/i);
  if (dashed) return normalizeParcelId(dashed[1]);

  const loose = text.match(/\b(\d{2,3})-(\d{2})-(\d{3})-(\d{2})-(\d{3})\b/);
  if (loose) {
    const padded = [
      loose[1].padStart(3, "0"),
      loose[2].padStart(2, "0"),
      loose[3].padStart(3, "0"),
      loose[4].padStart(2, "0"),
      loose[5].padStart(3, "0"),
    ].join("-");
    return normalizeParcelId(padded);
  }

  const compact = text.match(/\b(\d{13})\b/);
  if (compact) return parcelKeyToId(compact[1]);

  const labeled = text.match(/(?:parcel|pid|permanent\s*parcel)\s*(?:#|no\.?|number)?\s*[:#]?\s*([\d-]{13,21})/i);
  if (labeled) {
    const fromLabel = normalizeParcelId(labeled[1]) ?? parcelKeyToId(labeled[1]);
    if (fromLabel) return fromLabel;
  }

  return null;
}
