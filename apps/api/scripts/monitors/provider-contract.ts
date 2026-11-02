/**
 * Checks every configured Horizon-compatible provider of a network against the contract in
 * src/lib/monitors/provider-contract.ts and exits non-zero on any drift. GET only: no account,
 * no transaction, no signature.
 *
 *   PATH_ROUTING_API_TESTNET=https://... bun run scripts/monitors/provider-contract.ts testnet
 */
import { appendFile } from "node:fs/promises";
import { horizonProviders, isValidNetwork, type Network } from "@/config/networks";
import { checkProviders, type ProviderReport } from "@/lib/monitors/provider-contract";

async function run(network: Network): Promise<number> {
  const providers = horizonProviders(network);
  if (providers.length === 0) {
    console.error(`::error::No provider is configured for ${network}. The check did not run.`);
    return 1;
  }

  const reports: ProviderReport[] = await checkProviders(network, providers);
  const lines = reports.flatMap(({ label, problems }) =>
    problems.length === 0
      ? [`${label}: the contract holds`]
      : problems.map((problem) => `${label}: ${problem}`)
  );
  const failed = reports.some((r) => r.problems.length > 0);
  for (const line of lines) {
    if (line.endsWith("the contract holds")) console.log(line);
    else console.error(`::error::${line}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, `${lines.map((l) => `- ${l}`).join("\n")}\n`);
  return failed ? 1 : 0;
}

const network = process.argv[2] ?? "";
if (!isValidNetwork(network)) {
  console.error("Expected a network: mainnet or testnet.");
  process.exit(1);
}
process.exit(await run(network));
