import { FEATURES, PROTOCOLS, STATUS_LABEL } from "@/lib/site/status";
import {
  CHECK_STATEMENT,
  KEY_STATEMENT,
  REPO_URL,
  SERVER_KEYS,
  SERVER_KEYS_INTRO,
  serverKeyScope,
  VERIFY_SOURCE_URL,
} from "@/lib/site/trust";

const DOCS_URL = "https://docs.lumenwipe.com";

/** Line breaks would start a new Markdown block; nothing interpolated here may carry one. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The body of /llms.txt (llmstxt.org), from the same registry and wording the pages read.
 *  `siteUrl` is the deployment origin, or "" for links relative to it. */
export function renderLlmsTxt(siteUrl: string): string {
  const site = (path: string): string => `${siteUrl}${path}`;
  const features = FEATURES.map(
    (f) => `- ${oneLine(f.title)} (${STATUS_LABEL[f.status]}): ${oneLine(f.summary)}`
  );
  const protocols = PROTOCOLS.map((p) => `- ${oneLine(p.name)}: ${STATUS_LABEL[p.status]}`);
  const keys = SERVER_KEYS.map((k) => oneLine(`- ${k.name}: ${k.statement} ${serverKeyScope(k)}`));
  return [
    "# LumenWipe",
    "",
    "> Closes a Stellar account end to end and recovers the XLM locked in its reserves: it removes signers, data entries, offers and trustlines, exits Soroban DeFi positions, converts leftovers to XLM, and merges the account.",
    "",
    "Live means available on mainnet. Testnet only means it runs on Stellar testnet and not yet on mainnet.",
    "",
    "## Trust model",
    "",
    oneLine(KEY_STATEMENT),
    "",
    oneLine(CHECK_STATEMENT),
    "",
    oneLine(SERVER_KEYS_INTRO),
    "",
    ...keys,
    "",
    `The browser check is open source: ${VERIFY_SOURCE_URL}`,
    "",
    "## Features",
    "",
    ...features,
    "",
    "## Protocol exits",
    "",
    ...protocols,
    "",
    "## Links",
    "",
    `- [Security](${site("/security")}): the trust model and the keys on the server`,
    `- [How it works](${site("/how-it-works")}): the close, step by step`,
    `- [FAQ](${site("/faq")})`,
    `- [Documentation](${DOCS_URL})`,
    `- [Supported protocols, assets and wallets](${DOCS_URL}/reference/supported)`,
    `- [API reference](${DOCS_URL}/api-reference/introduction)`,
    `- [Source code](${REPO_URL})`,
    "",
  ].join("\n");
}
