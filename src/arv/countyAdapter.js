/**
 * @shared Routes ARV comp building to the active county adapter (see --county flag).
 */

import { getActiveCounty } from "../core/county-context.mjs";
import * as richland from "../counties/richland/arv-adapter.mjs";

const ADAPTERS = {
  richland,
};

function adapter() {
  const id = getActiveCounty();
  const mod = ADAPTERS[id];
  if (!mod) {
    throw new Error(`No ARV adapter for county "${id}". Add src/counties/${id}/arv-adapter.mjs`);
  }
  return mod;
}

export function subjectFromParcel(...args) {
  return adapter().subjectFromParcel(...args);
}

export function compFromSaleEvent(...args) {
  return adapter().compFromSaleEvent(...args);
}

export function saleWithinMonths(...args) {
  return adapter().saleWithinMonths(...args);
}

export function isValidSaleCandidate(...args) {
  return adapter().isValidSaleCandidate(...args);
}

export function buildCompsForSubject(...args) {
  return adapter().buildCompsForSubject(...args);
}
