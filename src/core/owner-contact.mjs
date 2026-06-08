/**
 * @shared Resolve who is safe to contact for outreach.
 * Auditor CAMA (OWNDATMAX) is the bulk truth source; Beacon is optional spot-check only.
 */

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeOwnerName(name) {
  return clean(name)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function ownersDiffer(a, b) {
  const left = normalizeOwnerName(a);
  const right = normalizeOwnerName(b);
  if (!left || !right) return false;
  return left !== right;
}

function distressOwnerCandidates(records = {}) {
  const candidates = [];

  for (const rec of records["tax-liens"] ?? []) {
    if (rec.label) {
      candidates.push({
        name: clean(rec.label),
        source: "tax-liens",
        role: "cert_list_owner",
        safe_to_contact: true,
      });
    }
  }

  for (const rec of records["lis-pendens"] ?? []) {
    if (rec.label) {
      candidates.push({
        name: clean(rec.label),
        source: "lis-pendens",
        role: "defendant_or_grantor",
        safe_to_contact: false,
      });
    }
  }

  for (const rec of records["clerk-foreclosures"] ?? []) {
    if (rec.label) {
      candidates.push({
        name: clean(rec.label),
        source: "clerk-foreclosures",
        role: "case_party",
        safe_to_contact: false,
      });
    }
  }

  for (const rec of records["evictions"] ?? []) {
    if (rec.label) {
      candidates.push({
        name: clean(rec.label),
        source: "evictions",
        role: "defendant",
        safe_to_contact: false,
      });
    }
  }

  for (const rec of records["probate-estates"] ?? []) {
    if (rec.label) {
      candidates.push({
        name: clean(rec.label),
        source: "probate-estates",
        role: "decedent",
        safe_to_contact: false,
      });
    }
  }

  return candidates;
}

export function resolveOwnerContact({ cluster, profile, beacon = null, auditor = null, auditorComp = null }) {
  const gisOwner =
    profile?.cama_raw?.MAILING_NAME_1 ?? profile?.cama_raw?.OWNER1 ?? null;
  const taxLienOwner = profile?.tax_lien?.owner_name ?? null;
  const auditorOwner = auditor?.owner_name ?? auditorComp?.auditor_owner_name ?? null;
  const auditorMailing =
    auditor?.mailing_address ??
    auditorComp?.auditor_mailing_address ??
    (auditorComp?.auditor_mailing_street
      ? [
          auditorComp.auditor_mailing_street,
          auditorComp.auditor_mailing_city,
          auditorComp.auditor_mailing_state,
          auditorComp.auditor_mailing_zip,
        ]
          .filter(Boolean)
          .join(", ")
      : null);
  const hasTaxLienSource = cluster.sources?.includes("tax-liens") ?? false;
  const candidates = distressOwnerCandidates(cluster.records);
  const beaconOk = beacon?.status === "ok" && beacon.owner_name;

  let contactOwner = null;
  let contactOwnerSource = null;
  let ownerVerification = "unverified";
  let safeToContact = false;
  let gisOwnerStale = auditor?.gis_owner_stale ?? auditorComp?.gis_owner_stale ?? false;
  let ownerWarning = null;
  let beaconSpotCheck = null;

  if (auditorOwner) {
    contactOwner = auditorOwner;
    contactOwnerSource = "auditor_cama";
    ownerVerification = "verified";
    safeToContact = true;
    if (ownersDiffer(gisOwner, auditorOwner)) {
      gisOwnerStale = true;
      ownerWarning = `GIS owner "${gisOwner}" differs from auditor CAMA — use CAMA owner only.`;
    }
    if (beaconOk && ownersDiffer(auditorOwner, beacon.owner_name)) {
      beaconSpotCheck = "disagrees";
      ownerWarning =
        (ownerWarning ? `${ownerWarning} ` : "") +
        `Beacon spot-check disagrees ("${beacon.owner_name}") — prefer auditor CAMA unless you re-verify.`;
    } else if (beaconOk) {
      beaconSpotCheck = "confirms";
    }
  } else if (hasTaxLienSource && taxLienOwner) {
    contactOwner = taxLienOwner;
    contactOwnerSource = "tax_lien_cert";
    ownerVerification = ownersDiffer(gisOwner, taxLienOwner) ? "cert_list_differs_from_gis" : "cert_list";
    safeToContact = true;
    if (ownersDiffer(gisOwner, taxLienOwner)) {
      gisOwnerStale = true;
      ownerWarning = `GIS owner "${gisOwner}" differs from tax cert list — use cert list owner only.`;
    }
    if (beaconOk && ownersDiffer(taxLienOwner, beacon.owner_name)) {
      beaconSpotCheck = "disagrees";
      ownerWarning =
        (ownerWarning ? `${ownerWarning} ` : "") +
        `Beacon spot-check disagrees — confirm owner before outreach.`;
    }
  } else if (beaconOk) {
    contactOwner = beacon.owner_name;
    contactOwnerSource = "beacon";
    ownerVerification = "beacon_only";
    safeToContact = true;
    ownerWarning = "Owner from Beacon only — no auditor CAMA overlay on this parcel.";
    if (ownersDiffer(gisOwner, contactOwner)) {
      gisOwnerStale = true;
      ownerWarning += ` GIS owner "${gisOwner}" differs from Beacon.`;
    }
  } else {
    const reviewCandidate = candidates.find((c) => !c.safe_to_contact);
    if (reviewCandidate) {
      ownerWarning =
        "Owner not verified — distress record names may be tenant, decedent, or case party. Use auditor CAMA or a Beacon spot-check before outreach.";
    } else if (gisOwner) {
      ownerWarning = `GIS owner "${gisOwner}" is unverified and may be stale — import auditor CAMA or run a Beacon spot-check.`;
      gisOwnerStale = null;
    } else {
      ownerWarning = "No verified owner — run import:auditor-cama or a Beacon spot-check before outreach.";
    }
  }

  const mailing_address =
    auditorMailing ??
    (beaconOk && beacon.mailing_address ? beacon.mailing_address : null) ??
    profile?.tax_lien?.mailing_address ??
    null;
  const mailing_source = auditorMailing
    ? "auditor_cama"
    : beaconOk && beacon.mailing_address
      ? "beacon"
      : profile?.tax_lien?.mailing_address
        ? "tax_lien_cert"
        : null;

  return {
    gis_owner_name: gisOwner,
    auditor_owner_name: auditorOwner,
    contact_owner: contactOwner,
    contact_owner_source: contactOwnerSource,
    mailing_address,
    mailing_source,
    owner_verification: ownerVerification,
    safe_to_contact: safeToContact,
    gis_owner_stale: gisOwnerStale,
    owner_warning: ownerWarning,
    beacon_spot_check: beaconSpotCheck,
    owner_candidates: candidates,
    owner_name: contactOwner,
  };
}
