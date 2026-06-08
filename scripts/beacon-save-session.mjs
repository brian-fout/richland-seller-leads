/**
 * Save Beacon browser session after passing Cloudflare manually.
 *
 * Usage: npm run beacon:session
 *   Opens Richland Beacon in a visible browser. Browse normally, then press Enter in terminal to save cookies.
 */

import readline from "readline";
import { BEACON_SEARCH_URL, createBeaconBrowser, saveBeaconSession } from "./beacon-parcel.mjs";

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const { browser, context, page } = await createBeaconBrowser({ headed: true });
  await page.goto(BEACON_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  console.error("Beacon session saver");
  console.error("  1. Complete any Cloudflare / disclaimer prompts in the browser");
  console.error("  2. Optionally open a parcel to confirm access works");
  console.error("  3. Press Enter here to save session to data/beacon-session.json");
  await waitForEnter("");
  const state = await context.storageState();
  saveBeaconSession(state);
  await browser.close();
  console.error("Saved data/beacon-session.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
