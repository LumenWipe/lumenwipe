import "server-only";
import { rpc } from "@stellar/stellar-sdk";
import { LumenWipeClient, type MediatorCheckResult } from "@lumenwipe/sdk";
import { SOROBAN_RPC_TESTNET_URL } from "./horizon-submit";
import { EXCHANGE_STAND_IN, isScenarioId, type ScenarioId } from "./scenarios";
import { EXPECTED_FEE_ACCOUNT_ENV, parseExpectedFeeAccount } from "./verify-feebump";
import { EXPECTED_MEDIATOR_ENV, parseExpectedMediator } from "./verify-mediator";
import { playgroundTokenDeployed, TOKEN_ADMIN_SECRET_ENV, tokenAdminKeypair } from "./token-deploy";

export const SWITCHED_OFF_REASON = "Switched off on this deployment for now.";
export const FEE_ACCOUNT_MISSING_REASON =
  "Not set up on this deployment: it has no fee account address to check the sponsored fee against.";
export const MEDIATOR_KEY_MISSING_REASON =
  "Not set up on this deployment: it has no mediator key to check the exchange close's co-signature against.";
export const EXCHANGE_API_MISSING_REASON =
  "Not set up on this deployment: it has no LumenWipe API to ask whether an exchange close can run.";
export const EXCHANGE_CHECK_FAILED_REASON =
  "The LumenWipe API could not say whether it can close into the test exchange right now.";
export const EXCHANGE_NOT_ROUTED_REASON =
  "The LumenWipe API does not route the test exchange through its relay account with an id memo.";
export const MEDIATOR_UNAVAILABLE_REASON =
  "The LumenWipe API cannot co-sign an exchange close on the test network right now.";
export const TOKEN_ADMIN_MISSING_REASON =
  "Not set up on this deployment: it has no key for the admin of the playground's token.";
export const TOKEN_NOT_DEPLOYED_REASON = "The playground's token is not on testnet yet.";
export const TOKEN_CHECK_FAILED_REASON =
  "The playground could not read its token on testnet right now.";
export const REGISTRY_STALE_REASON =
  "The LumenWipe API's exchange registry is past its verification window, so it refuses exchange closes.";

/** How long the availability read waits for the API's mediator check. */
const MEDIATOR_CHECK_TIMEOUT_MS = 5_000;
/** How long it waits for the token's ledger read. */
const TOKEN_CHECK_TIMEOUT_MS = 5_000;

/**
 * Reads PLAYGROUND_DISABLED_SCENARIOS, a comma-separated list of scenario ids, so a flaky one can
 * be hidden by changing configuration instead of code. Unknown ids are ignored.
 */
export function parseDisabledScenarios(raw: string | undefined): Map<ScenarioId, string> {
  const disabled = new Map<ScenarioId, string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (isScenarioId(id)) disabled.set(id, SWITCHED_OFF_REASON);
  }
  return disabled;
}

/** The scenarios a deployment's configuration alone rules out: those it switched off, the
 *  sponsored fee without a valid fee account address, and the exchange close without a valid
 *  mediator key. */
export function unavailableFrom(env: {
  disabled: string | undefined;
  feeAccount: string | undefined;
  mediatorKey: string | undefined;
}): Map<ScenarioId, string> {
  const unavailable = parseDisabledScenarios(env.disabled);
  if (!unavailable.has("fee-bump") && parseExpectedFeeAccount(env.feeAccount) === null) {
    unavailable.set("fee-bump", FEE_ACCOUNT_MISSING_REASON);
  }
  if (!unavailable.has("exchange-close") && parseExpectedMediator(env.mediatorKey) === null) {
    unavailable.set("exchange-close", MEDIATOR_KEY_MISSING_REASON);
  }
  return unavailable;
}

/**
 * Why the API's mediator check for the stand-in rules the exchange close out, or null when it can
 * run: the API must route the stand-in through its relay with an id memo, be able to co-sign, and
 * hold a registry inside its verification window. A check that could not be read rules it out.
 */
export function exchangeUnavailableReason(check: MediatorCheckResult | null): string | null {
  if (check === null) return EXCHANGE_CHECK_FAILED_REASON;
  if (!check.requiresMediator || !check.requiresMemo || check.memoType !== "id") {
    return EXCHANGE_NOT_ROUTED_REASON;
  }
  if (!check.available) return MEDIATOR_UNAVAILABLE_REASON;
  if (!check.registryFresh) return REGISTRY_STALE_REASON;
  return null;
}

/** Adds the exchange close, with its reason, when the API's mediator check rules it out. The API
 *  is asked only when configuration has not already ruled it out. */
export async function withMediatorCheck(
  unavailable: Map<ScenarioId, string>,
  check: () => Promise<MediatorCheckResult>
): Promise<Map<ScenarioId, string>> {
  if (unavailable.has("exchange-close")) return unavailable;
  let result: MediatorCheckResult | null;
  try {
    result = await check();
  } catch {
    result = null;
  }
  const reason = exchangeUnavailableReason(result);
  if (reason !== null) unavailable.set("exchange-close", reason);
  return unavailable;
}

/**
 * Adds the Soroban token, with its reason, unless this deployment holds its pinned admin's key and
 * the token is on testnet: it is not between a deployment and the operator's one-off token
 * deployment, or when the ledger read fails. The ledger is read only when nothing else has ruled
 * it out.
 */
export async function withTokenCheck(
  unavailable: Map<ScenarioId, string>,
  adminConfigured: boolean,
  deployed: () => Promise<boolean>
): Promise<Map<ScenarioId, string>> {
  if (unavailable.has("soroban-token")) return unavailable;
  if (!adminConfigured) {
    unavailable.set("soroban-token", TOKEN_ADMIN_MISSING_REASON);
    return unavailable;
  }
  let reason: string | null;
  try {
    reason = (await deployed()) ? null : TOKEN_NOT_DEPLOYED_REASON;
  } catch {
    reason = TOKEN_CHECK_FAILED_REASON;
  }
  if (reason !== null) unavailable.set("soroban-token", reason);
  return unavailable;
}

/** The scenarios this deployment cannot run, read on each request. */
export async function unavailableScenarios(): Promise<Map<ScenarioId, string>> {
  const configured = unavailableFrom({
    disabled: process.env.PLAYGROUND_DISABLED_SCENARIOS,
    feeAccount: process.env[EXPECTED_FEE_ACCOUNT_ENV],
    mediatorKey: process.env[EXPECTED_MEDIATOR_ENV],
  });
  const adminConfigured = tokenAdminKeypair(process.env[TOKEN_ADMIN_SECRET_ENV]) !== null;
  const unavailable = await withTokenCheck(configured, adminConfigured, () =>
    playgroundTokenDeployed(
      new rpc.Server(SOROBAN_RPC_TESTNET_URL, { timeout: TOKEN_CHECK_TIMEOUT_MS })
    )
  );
  const apiUrl = process.env.LUMENWIPE_API_URL;
  const apiKey = process.env.LUMENWIPE_API_KEY;
  if (!apiUrl || !apiKey) {
    if (!unavailable.has("exchange-close")) {
      unavailable.set("exchange-close", EXCHANGE_API_MISSING_REASON);
    }
    return unavailable;
  }
  const client = new LumenWipeClient({
    baseUrl: apiUrl,
    apiKey,
    network: "testnet",
    timeout: MEDIATOR_CHECK_TIMEOUT_MS,
  });
  return withMediatorCheck(unavailable, () =>
    client.mediatorCheck(EXCHANGE_STAND_IN.address, "testnet")
  );
}
