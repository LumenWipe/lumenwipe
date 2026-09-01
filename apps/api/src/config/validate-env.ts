/**
 * Startup configuration check.
 *
 * The service used to boot happily without the config it needs and fail later, per request, in
 * whatever way each missing value happened to break. That is the expensive kind of failure: a
 * green deploy, a healthy-looking instance, and users meeting the problem one at a time. This
 * turns it into a refusal to start, with the variable named.
 *
 * The line it draws is between config that is *required to do the job at all* and config that
 * only enables an optional path. A missing API key means every authenticated route rejects
 * everything - the service is up and useless, which is worse than down. A missing mainnet
 * mediator secret means exchange closes on mainnet are unavailable, which is a real and
 * currently intended state; refusing to boot over it would take testnet down with it.
 */

export interface EnvProblem {
  variable: string;
  message: string;
}

/** Values without which the service cannot serve its purpose. */
const REQUIRED: Array<{ name: string; why: string }> = [
  {
    name: "API_KEYS",
    why:
      "every authenticated route rejects every request without it, so the service would be " +
      "running and unusable",
  },
];

/**
 * Values whose absence disables a path rather than the service. Reported at startup so the
 * operator learns it here, not from a user hitting the disabled path.
 */
const OPTIONAL: Array<{ name: string; consequence: string }> = [
  {
    name: "MEDIATOR_SECRET_MAINNET",
    consequence: "mainnet exchange closes are unavailable (testnet is unaffected)",
  },
  {
    name: "MEDIATOR_SECRET_TESTNET",
    consequence: "testnet exchange closes are unavailable",
  },
  {
    name: "OCTOPOS_API_KEY",
    consequence:
      "DeFi position detection runs at OctoPos's free/IP rate-limit tier instead of the " +
      "authenticated tier",
  },
];

/**
 * Checks the environment. Returns the fatal problems; `warnings` are for logging.
 *
 * Pure and returning rather than throwing, so the boot sequence decides what to do and so this
 * is testable without spawning a process.
 */
export function checkEnv(env: NodeJS.ProcessEnv = process.env): {
  problems: EnvProblem[];
  warnings: EnvProblem[];
} {
  const problems: EnvProblem[] = [];
  const warnings: EnvProblem[] = [];

  for (const { name, why } of REQUIRED) {
    // Whitespace-only counts as missing: `API_KEYS=""` in a deploy config is a mistake, not a
    // deliberate choice to reject all traffic.
    if (!env[name] || env[name]!.trim() === "") {
      problems.push({ variable: name, message: `${name} is not set - ${why}.` });
    }
  }

  const apiKeys = env.API_KEYS?.trim();
  if (apiKeys && countUsableKeys(apiKeys) === 0) {
    // Counted with the same rule the service parses by, not a substring check for "=". A
    // check that only looked for the character passed `=abc` (empty label) and `label=`
    // (empty key), both of which yield zero usable keys - so the process booted green and
    // every authenticated route 401'd, which is exactly the state this exists to prevent.
    problems.push({
      variable: "API_KEYS",
      message:
        "API_KEYS yields no usable key. It must be comma-separated `label=key` pairs with " +
        "both halves non-empty; the client's 401 gives no hint that the server side is " +
        "malformed.",
    });
  }

  for (const { name, consequence } of OPTIONAL) {
    if (!env[name] || env[name]!.trim() === "") {
      warnings.push({ variable: name, message: `${name} is not set - ${consequence}.` });
    }
  }

  return { problems, warnings };
}

/**
 * How many usable keys a raw API_KEYS value yields.
 *
 * Mirrors `ApiKeyService`'s parse deliberately: `indexOf("=")` so a key containing `=` (base64
 * padding) keeps its padding, `eq <= 0` so an empty label is rejected, and both halves
 * required after trimming.
 */
function countUsableKeys(raw: string): number {
  return raw.split(",").filter((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) return false;
    return pair.slice(0, eq).trim().length > 0 && pair.slice(eq + 1).trim().length > 0;
  }).length;
}

/** Formats the fatal problems into the message the process exits with. */
export function formatEnvFailure(problems: EnvProblem[]): string {
  return [
    "Refusing to start: required configuration is missing or malformed.",
    ...problems.map((p) => `  - ${p.message}`),
    "See apps/api/.env.example for the expected shape.",
  ].join("\n");
}
