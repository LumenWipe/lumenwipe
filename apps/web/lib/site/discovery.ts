import { createHash } from "node:crypto";
import { DOCS_URL } from "@/config/discovery-links.mjs";
import { siteUrl } from "@/lib/site/url";

export const API_URL = "https://api.lumenwipe.com";
export const STATUS_URL = "https://status.lumenwipe.com";
export const SKILLS_INDEX_PATH = "/.well-known/agent-skills/index.json";
export const ARD_PATH = "/.well-known/ard.json";
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
export const AUTH_PATH = "/auth.md";

const SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const PUBLISHER = "lumenwipe.com";
const NEVER_HOLDS_KEY =
  "The API never holds or receives the private key of the account. You sign locally, and the API only builds the unsigned transaction and submits the one you signed.";

export const skillPath = (name: string): string => `/.well-known/agent-skills/${name}/SKILL.md`;

export function renderAuthMd(origin: string = siteUrl("/")): string {
  const keysPage = new URL("/api-keys", origin).toString();
  return [
    "# LumenWipe API keys",
    "",
    "The LumenWipe API uses API keys. It does not use OAuth, and it has no endpoint where a program can register or create a key by itself: a person creates the key on the API keys page.",
    "",
    "## Get a key",
    "",
    `1. Open ${keysPage}.`,
    "2. Sign in with a Stellar wallet that can sign a message: Varial (formerly Freighter), xBull or Hana, or WalletConnect with a phone wallet that supports message signing. The wallet signs a one-time SEP-53 message, not a transaction: it moves no funds and costs no fee.",
    "3. Optionally give the key a label and limit it to mainnet or testnet. Both are fixed once the key is created. Then create the key.",
    "4. Copy the key. It is shown once.",
    "",
    "## Use the key",
    "",
    "Send it as a bearer token in the `Authorization` header:",
    "",
    "```text",
    "Authorization: Bearer <your key>",
    "```",
    "",
    "Keep the key on a server, never in browser code. Most routes take the network in the path, `mainnet` or `testnet`, for example `/v1/testnet/account/G...`. A key limited to one network is refused with `403 key_network_not_allowed` on the other.",
    "",
    "`GET /`, the health routes and `GET /v1/config/exchange-registry` need no key. Everything else does.",
    "",
    "## Limits",
    "",
    "- 120 requests per 60 seconds per API key by default. Over the limit the API answers `429 rate_limited` with `Retry-After` and `RateLimit-*` headers.",
    "- 5 active keys per wallet.",
    "- JSON request bodies up to 100 KB.",
    "",
    "## More",
    "",
    `- [Authentication in the API reference](${DOCS_URL}/api-reference/introduction#authentication)`,
    `- [Limits](${DOCS_URL}/integrators/limits)`,
    `- [Quickstart](${DOCS_URL}/integrators/quickstart)`,
    "",
  ].join("\n");
}

export interface AgentSkill {
  name: string;
  description: string;
  body: string;
}

const COMMON_RULES = [
  "## Rules",
  "",
  `- ${NEVER_HOLDS_KEY}`,
  `- Every request except the no-key routes needs an API key. See ${DOCS_URL}/api-reference/introduction#authentication.`,
  "- The network is `mainnet` or `testnet`, in the path after `/v1/`.",
];

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    name: "analyze-stellar-account",
    description:
      "Use to read a Stellar account through the LumenWipe API (balances, trustlines, offers, signers and thresholds) and to preview what closing it would involve, with its blockers and decisions, before anything is built or signed. Read-only.",
    body: [
      "# Analyze a Stellar account",
      "",
      "Reads an account and previews a close. Nothing here builds or signs a transaction.",
      "",
      "## Steps",
      "",
      `1. \`GET ${API_URL}/v1/{network}/account/{address}\` returns the account as the API reads it. With \`@lumenwipe/sdk\`: \`client.getAccount(address)\`.`,
      "2. `POST /v1/{network}/close/plan` with `{ source, destination }` returns the plan: its `blockers`, the `decisionPoints` a person must answer, and estimates. The destination may be omitted to preview. With the SDK: `client.closePlan({ source, destination })`.",
      "3. If `blockers` is not empty, stop and show them to the user.",
      "",
      ...COMMON_RULES,
      "",
      "## Links",
      "",
      `- [Close plan](${DOCS_URL}/sdk/close-plan)`,
      `- [Client methods](${DOCS_URL}/sdk/client)`,
      `- [API reference](${DOCS_URL}/api-reference/introduction)`,
      "",
    ].join("\n"),
  },
  {
    name: "close-stellar-account",
    description:
      "Use to close a Stellar account through the LumenWipe API: plan it, fetch the unsigned transactions round by round, verify each one with @lumenwipe/verify before signing, sign locally, submit, and read what the destination received. A close merges the account and cannot be undone.",
    body: [
      "# Close a Stellar account",
      "",
      "A close removes what holds the account open and merges it into a destination. It cannot be undone, so every choice about the user's assets is the user's to make.",
      "",
      "## Steps",
      "",
      "1. Plan: `POST /v1/{network}/close/plan` with `{ source, destination }`. Stop on any blocker. Ask the user for every required decision point, including the acknowledgement of a destination LumenWipe does not recognize: each is the user's own choice, never yours. Keep the `planHash` of the plan the user reviewed.",
      "2. Fetch: `POST /v1/{network}/close/transactions` with `{ source, destination, decisions, planHash }`. It returns the next round of unsigned transactions.",
      "3. Verify every transaction with `@lumenwipe/verify` before signing it: `verifyCloseTransaction` with the destination and per-asset choices the user made and the account read the user reviewed, plus `exitExpectations(account, network)` and `poolWithdrawalExpectations(account)`. Take no expectation from the transaction or from its `intent` summary. It throws `VerificationError` on any mismatch: do not sign.",
      "4. Sign locally, then `POST /v1/{network}/submit` with `{ signedXdr }`.",
      "5. If `remaining.requiresAnotherCall` is true, fetch the next round and repeat from step 3.",
      "6. `GET /v1/{network}/close/delivered` with the destination and the confirmed hashes reads what the destination received.",
      "",
      "`runClose` in `@lumenwipe/sdk` drives steps 2 to 5 and calls your `verify` before every signature.",
      "",
      ...COMMON_RULES,
      "- A close must be verified with `@lumenwipe/verify` before signing. The SDK does not verify or sign anything.",
      "",
      "## Links",
      "",
      `- [Quickstart](${DOCS_URL}/integrators/quickstart)`,
      `- [Verification](${DOCS_URL}/sdk/verification)`,
      `- [runClose](${DOCS_URL}/sdk/run-close)`,
      `- [How a close works](${DOCS_URL}/guides/how-closing-works)`,
      "",
    ].join("\n"),
  },
  {
    name: "revoke-token-allowance",
    description:
      "Use to find and revoke SEP-41 token allowances an account has granted, through the LumenWipe API: read the live allowances, build the unsigned revoking transaction, verify it with @lumenwipe/verify, sign locally and submit.",
    body: [
      "# Revoke a token allowance",
      "",
      "Lists the SEP-41 allowances an account has granted and revokes one. It does not close the account.",
      "",
      "## Steps",
      "",
      "1. `GET /v1/{network}/allowances/{address}` lists every live allowance the account has granted. With `@lumenwipe/sdk`: `client.getAllowances(address)`.",
      "2. `POST /v1/{network}/allowances/revoke` with `{ owner, token, spender }` returns the unsigned transaction as `transaction`. With the SDK: `client.revokeAllowance({ owner, token, spender })`.",
      "3. Verify it with `verifyRevokeAllowanceTransaction(unsignedXdr, networkPassphrase, { owner, token, spender })` from `@lumenwipe/verify`, with the values the user chose. It throws `RevokeAllowanceVerificationError` on any mismatch: do not sign.",
      "4. Sign locally, then `POST /v1/{network}/submit` with `{ signedXdr }`.",
      "",
      ...COMMON_RULES,
      "- A revoking transaction must be verified with `@lumenwipe/verify` before signing.",
      "",
      "## Links",
      "",
      `- [Client methods](${DOCS_URL}/sdk/client)`,
      `- [Verification](${DOCS_URL}/sdk/verification)`,
      `- [API reference](${DOCS_URL}/api-reference/introduction)`,
      "",
    ].join("\n"),
  },
];

/** The SKILL.md text: front matter naming the skill, then its instructions. */
export function renderSkillMarkdown(skill: AgentSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "---",
    "",
    skill.body,
  ].join("\n");
}

export function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function renderSkillsIndex(): string {
  return `${JSON.stringify(
    {
      $schema: SKILLS_SCHEMA,
      skills: AGENT_SKILLS.map((skill) => ({
        name: skill.name,
        type: "skill-md",
        description: skill.description,
        url: skillPath(skill.name),
        digest: sha256Digest(renderSkillMarkdown(skill)),
      })),
    },
    null,
    2
  )}\n`;
}

export interface ArdEntry {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  description: string;
  representativeQueries: string[];
}

export function ardEntries(origin: string = siteUrl("/")): ArdEntry[] {
  return [
    {
      identifier: `urn:air:${PUBLISHER}:api/openapi`,
      displayName: "LumenWipe API OpenAPI document",
      type: "application/json",
      url: `${API_URL}/docs-json`,
      description:
        "The OpenAPI 3 description of the LumenWipe REST API, which reads Stellar accounts and builds the unsigned transactions of a close.",
      representativeQueries: [
        "which endpoints does the LumenWipe API have",
        "how do I plan the close of a Stellar account through an API",
      ],
    },
    {
      identifier: `urn:air:${PUBLISHER}:docs`,
      displayName: "LumenWipe documentation",
      type: "text/html",
      url: DOCS_URL,
      description:
        "Guides, the API reference, the SDK reference and the security documentation for LumenWipe.",
      representativeQueries: [
        "how do I close a Stellar account programmatically",
        "how do I verify a LumenWipe transaction before signing",
      ],
    },
    {
      identifier: `urn:air:${PUBLISHER}:status`,
      displayName: "LumenWipe status page",
      type: "text/html",
      url: STATUS_URL,
      description: "The public status page of the LumenWipe service.",
      representativeQueries: [
        "is the LumenWipe API up",
        "is there an incident affecting LumenWipe",
      ],
    },
    {
      identifier: `urn:air:${PUBLISHER}:agent-skills`,
      displayName: "LumenWipe agent skills index",
      type: "application/json",
      url: new URL(SKILLS_INDEX_PATH, origin).toString(),
      description:
        "Index of the agent skills for analyzing a Stellar account, closing it with client-side verification, and revoking a token allowance.",
      representativeQueries: [
        "which skills does LumenWipe offer an agent",
        "how can an agent revoke a Stellar token allowance",
      ],
    },
  ];
}

/** One document for both `/.well-known/ard.json` and its predecessor path `ai-catalog.json`:
 *  `specVersion` and `host` are the AI Catalog members, `entries` is common to both. */
export function renderArdManifest(origin: string = siteUrl("/")): string {
  return `${JSON.stringify(
    {
      specVersion: "0.9",
      host: { displayName: "LumenWipe", documentationUrl: DOCS_URL },
      entries: ardEntries(origin),
    },
    null,
    2
  )}\n`;
}
