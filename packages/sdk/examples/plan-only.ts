import {
  LumenWipeClient,
  type AccountState,
  type Network,
  type PlanResponse,
} from "@lumenwipe/sdk";
import { requireEnv, runMain } from "./support";

export interface RehearsalInput {
  source: string;
  destination: string;
  network: Network;
}

export interface Rehearsal {
  account: AccountState;
  plan: PlanResponse;
}

/** Exit code when the plan has blockers, so a script can tell "blocked" from "failed". */
export const BLOCKED_EXIT_CODE = 2;

/**
 * Reads the account and plans its close. Nothing else: no transaction is requested, built or
 * signed, and no key is held, so it is safe to point at a real mainnet account.
 */
export async function rehearseClose(
  client: Pick<LumenWipeClient, "getAccount" | "closePlan">,
  { source, destination, network }: RehearsalInput
): Promise<Rehearsal> {
  const account = await client.getAccount(source, network);
  const plan = await client.closePlan({ source, destination }, network);
  return { account, plan };
}

export function describeRehearsal({ account, plan }: Rehearsal, input: RehearsalInput): string[] {
  const lines = [
    `${input.source} on ${input.network}: ${account.numSubEntries} sub-entries, balance ${account.nativeBalanceLumens} XLM`,
    `Plan ${plan.planHash} (${plan.status}) into ${input.destination}`,
  ];
  const required = plan.decisionPoints.filter((dp) => dp.required);
  if (required.length > 0) {
    lines.push(`Decisions to answer: ${required.map((dp) => dp.id).join(", ")}`);
  }
  if (plan.blockers.length === 0) {
    lines.push("No blockers.");
  } else {
    lines.push(`Blocked by ${plan.blockers.length}:`);
    for (const b of plan.blockers) {
      lines.push(`  ${b.code}: ${b.message}${b.helpUrl ? ` (${b.helpUrl})` : ""}`);
    }
  }
  return lines;
}

export async function runPlanOnly(
  client: Pick<LumenWipeClient, "getAccount" | "closePlan">,
  input: RehearsalInput,
  log: (line: string) => void = console.log
): Promise<number> {
  const rehearsal = await rehearseClose(client, input);
  describeRehearsal(rehearsal, input).forEach((line) => log(line));
  return rehearsal.plan.blockers.length > 0 ? BLOCKED_EXIT_CODE : 0;
}

if (import.meta.main) {
  const network = process.env.LUMENWIPE_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    console.error('LUMENWIPE_NETWORK must be "testnet" or "mainnet".');
    process.exit(1);
  }
  const input: RehearsalInput = {
    source: requireEnv("SOURCE", "the public address of the account to rehearse"),
    destination: requireEnv("DESTINATION", "the public address that would receive the XLM"),
    network,
  };
  const client = new LumenWipeClient({
    baseUrl: process.env.LUMENWIPE_API_URL ?? "https://api.lumenwipe.com",
    apiKey: requireEnv("LUMENWIPE_API_KEY", "create one at https://lumenwipe.com/api-keys"),
    network,
  });
  runMain(() => runPlanOnly(client, input));
}
