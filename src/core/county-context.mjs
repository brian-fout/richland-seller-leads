/**
 * Active county for the current process (CLI --county flag).
 */

import { countyPaths, DEFAULT_COUNTY, parseCountyArg } from "./county-paths.mjs";

let activeCountyId = parseCountyArg();

export function setActiveCounty(countyId) {
  activeCountyId = countyId || DEFAULT_COUNTY;
}

export function getActiveCounty() {
  return activeCountyId;
}

export function paths() {
  return countyPaths(activeCountyId);
}

export function dataRoot() {
  return paths().dataRoot;
}
