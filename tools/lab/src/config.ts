import { isAbsolute, join } from "node:path";
import { LabRefusal, checkoutRoot, readPrivateFileIfPresent } from "./home";
import type { Network } from "./scenarios";

export interface LabConfig {
  productionUrl: string;
  localEnv: Record<string, string>;
  e2e?: {
    sourceSecretFile: string;
    destinations: string[];
    balanceCapXlm?: string | number;
    horizon: Record<Network, string>;
  };
}

export const PRODUCTION_URL = "https://api.lumenwipe.com";
const PUBLIC_HORIZON: Record<Network, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

function httpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || !URL.canParse(value) || new URL(value).protocol !== "https:") {
    throw new LabRefusal(`config.json ${field} must be an https URL`);
  }
  return value.replace(/\/+$/, "");
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LabRefusal(`config.json ${field} must be an object of strings`);
  }
  for (const v of Object.values(value)) {
    if (typeof v !== "string")
      throw new LabRefusal(`config.json ${field} must be an object of strings`);
  }
  return value as Record<string, string>;
}

export function parseConfig(raw: string, home: string): LabConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new LabRefusal("config.json is not valid JSON");
  }
  const local = (parsed.local ?? {}) as Record<string, unknown>;
  const config: LabConfig = {
    productionUrl:
      parsed.productionUrl === undefined
        ? PRODUCTION_URL
        : httpsUrl(parsed.productionUrl, "productionUrl"),
    localEnv: stringRecord(local.env, "local.env"),
  };
  if (parsed.e2e !== undefined) {
    const e2e = parsed.e2e as Record<string, unknown>;
    if (typeof e2e.sourceSecretFile !== "string" || e2e.sourceSecretFile === "") {
      throw new LabRefusal("config.json e2e.sourceSecretFile is required");
    }
    if (!Array.isArray(e2e.destinations) || !e2e.destinations.every((d) => typeof d === "string")) {
      throw new LabRefusal("config.json e2e.destinations must be a list of account addresses");
    }
    const horizon = stringRecord(e2e.horizon, "e2e.horizon");
    config.e2e = {
      sourceSecretFile: isAbsolute(e2e.sourceSecretFile)
        ? e2e.sourceSecretFile
        : join(home, e2e.sourceSecretFile),
      destinations: e2e.destinations as string[],
      balanceCapXlm: e2e.balanceCapXlm as string | number | undefined,
      horizon: {
        testnet: horizon.testnet
          ? httpsUrl(horizon.testnet, "e2e.horizon.testnet")
          : PUBLIC_HORIZON.testnet,
        mainnet: horizon.mainnet
          ? httpsUrl(horizon.mainnet, "e2e.horizon.mainnet")
          : PUBLIC_HORIZON.mainnet,
      },
    };
  }
  return config;
}

/** `config.json` in the lab folder. Optional for `measure`; it can hold provider keys, so it is
 *  read under the same rules as a key file. */
export function loadConfig(home: string, root = checkoutRoot()): LabConfig {
  const file = join(home, "config.json");
  return parseConfig(readPrivateFileIfPresent(file, "config.json", root) ?? "{}", home);
}
