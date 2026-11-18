// Picks the nightly's random wallet before the suite runs: logs its replay code as a notice and
// hands it to the later steps as `code` and `version` outputs.
//
//   LUMENWIPE_SEED=<replay code, optional> bun run nightly-seed
import { appendFileSync } from "node:fs";
import { nightlySeed, SEED_ENV } from "./nightly-seed";

const { code, version } = nightlySeed(new Date(), process.env[SEED_ENV]);
process.stdout.write(`::notice title=Random wallet::Replay code ${code}, generator v${version}\n`);
const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `code=${code}\nversion=${version}\n`);
