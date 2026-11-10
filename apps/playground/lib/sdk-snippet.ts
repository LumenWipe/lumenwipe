import { StrKey } from "@stellar/stellar-sdk";
import type { PlaygroundCloseExpectation } from "./verify";

/** A classic asset, by its code and the issuer it returns to. */
export interface SnippetAsset {
  code: string;
  issuer: string;
}

export type SnippetDestination =
  | { kind: "account"; address: string }
  | { kind: "exchange"; address: string; memo: string; memoType: "id" };

export type SnippetDecision =
  | { kind: "return_to_issuer"; asset: SnippetAsset }
  | { kind: "convert_to_xlm"; asset: SnippetAsset; minAmountOut: string }
  | { kind: "transfer"; asset: SnippetAsset; to: string; amount: string }
  | { kind: "claim"; balanceId: string; addTrustline: SnippetAsset | null }
  | { kind: "forfeit"; balanceId: string };

/** A signer the account holds besides its master key, by its public strkey. */
export interface SnippetSigner {
  type: "ed25519_public_key" | "hash_x" | "preauth_tx";
  key: string;
}

/** One account's close, in public data only: every key is a public strkey. */
export interface SnippetClose {
  source: string;
  destination: SnippetDestination;
  decisions: readonly SnippetDecision[];
  signers: readonly SnippetSigner[];
  /** The API's fee sponsor pays the close's fees. */
  sponsored: boolean;
}

/** What the snippet shows. A batch form (`batchPlan`, then one close per address) would add a
 *  variant here and reuse `closeBody` for each account. */
export interface SdkSnippetInput {
  network: "testnet" | "mainnet";
  close: SnippetClose;
}

export class SdkSnippetInputError extends Error {
  constructor(readonly field: string) {
    super(`The SDK snippet input has an invalid ${field}`);
    this.name = "SdkSnippetInputError";
  }
}

// The API's decision ids and choices (apps/api/src/lib/close-api/decisions.ts), restated: they are
// its wire contract, and the playground never imports apps/api.
const destinationId = (address: string): string => `destination:${address}`;
const assetId = ({ code, issuer }: SnippetAsset): string => `asset:${code}-${issuer}`;
const claimId = (balanceId: string): string => `claim:${balanceId}`;
const FORFEITED_BLOCKER = "claimable_balance_forfeited";

const UINT64_MAX = BigInt("18446744073709551615");

function publicKey(value: string, field: string): string {
  if (!StrKey.isValidEd25519PublicKey(value)) throw new SdkSnippetInputError(field);
  return value;
}

function matching(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) throw new SdkSnippetInputError(field);
  return value;
}

function asset(value: SnippetAsset): SnippetAsset {
  return {
    code: matching(value.code, /^[A-Za-z0-9]{1,12}$/, "asset code"),
    issuer: publicKey(value.issuer, "asset issuer"),
  };
}

function idMemo(value: string): string {
  matching(value, /^(0|[1-9][0-9]{0,19})$/, "memo");
  if (BigInt(value) > UINT64_MAX) throw new SdkSnippetInputError("memo");
  return value;
}

const STROOPS = /^[1-9][0-9]*$/;
const AMOUNT = /^[0-9]+(\.[0-9]{1,7})?$/;
const BALANCE_ID = /^[0-9a-f]{72}$/;

function decision(value: SnippetDecision): SnippetDecision {
  switch (value.kind) {
    case "return_to_issuer":
      return { kind: value.kind, asset: asset(value.asset) };
    case "convert_to_xlm":
      return {
        kind: value.kind,
        asset: asset(value.asset),
        minAmountOut: matching(value.minAmountOut, STROOPS, "minimum amount out"),
      };
    case "transfer":
      return {
        kind: value.kind,
        asset: asset(value.asset),
        to: publicKey(value.to, "transfer destination"),
        amount: matching(value.amount, AMOUNT, "transfer amount"),
      };
    case "claim":
      return {
        kind: value.kind,
        balanceId: matching(value.balanceId, BALANCE_ID, "balance id"),
        addTrustline: value.addTrustline && asset(value.addTrustline),
      };
    case "forfeit":
      return { kind: value.kind, balanceId: matching(value.balanceId, BALANCE_ID, "balance id") };
    default:
      throw new SdkSnippetInputError("decision");
  }
}

function signer(value: SnippetSigner): SnippetSigner {
  const { type, key } = value;
  if (type === "ed25519_public_key") return { type, key: publicKey(key, "signer") };
  if (type !== "hash_x" && type !== "preauth_tx") throw new SdkSnippetInputError("signer type");
  try {
    if (type === "hash_x") StrKey.decodeSha256Hash(key);
    else StrKey.decodePreAuthTx(key);
  } catch {
    throw new SdkSnippetInputError("signer");
  }
  return { type, key };
}

/** The input rebuilt from validated fields only, so nothing the caller added can reach the text. */
function validated(input: SdkSnippetInput): SdkSnippetInput {
  if (input.network !== "testnet" && input.network !== "mainnet") {
    throw new SdkSnippetInputError("network");
  }
  const { close } = input;
  const address = publicKey(close.destination.address, "destination");
  const destination: SnippetDestination =
    close.destination.kind === "exchange"
      ? { kind: "exchange", address, memo: idMemo(close.destination.memo), memoType: "id" }
      : { kind: "account", address };
  return {
    network: input.network,
    close: {
      source: publicKey(close.source, "source"),
      destination,
      decisions: close.decisions.map(decision),
      signers: close.signers.map(signer),
      sponsored: close.sponsored === true,
    },
  };
}

/** A `CODE:ISSUER` asset as its parts. */
function assetOf(canonicalAsset: string): SnippetAsset {
  const [code = "", issuer = "", ...rest] = canonicalAsset.split(":");
  if (rest.length > 0) throw new SdkSnippetInputError("asset");
  return asset({ code, issuer });
}

const str = (value: string): string => JSON.stringify(value);
const canonical = ({ code, issuer }: SnippetAsset): string => `${code}:${issuer}`;

/** An object literal's field: a key (printed as is) and the code of its value. A key alone is a
 *  shorthand property. */
type Field = readonly [key: string, value?: string];

const WIDTH = 100;

/**
 * An object literal as code lines, on one line when it fits the width and one field per line
 * otherwise. `head` precedes the brace, `tail` follows it.
 */
function objectLines(
  indent: string,
  head: string,
  fields: readonly Field[],
  tail: string
): string[] {
  const text = fields.map(([key, value]) => (value === undefined ? key : `${key}: ${value}`));
  const single = `${indent}${head}${text.length === 0 ? "{}" : `{ ${text.join(", ")} }`}${tail}`;
  if (single.length <= WIDTH) return [single];
  return [`${indent}${head}{`, ...text.map((t) => `${indent}  ${t},`), `${indent}}${tail}`];
}

function answerFields(d: SnippetDecision): Field[] {
  switch (d.kind) {
    case "return_to_issuer":
      return [
        ["id", str(assetId(d.asset))],
        ["choice", str("return_to_issuer")],
      ];
    case "convert_to_xlm":
      return [
        ["id", str(assetId(d.asset))],
        ["choice", str("convert_to_xlm")],
        ["params", `{ minAmountOut: ${str(d.minAmountOut)} }`],
      ];
    case "transfer":
      return [
        ["id", str(assetId(d.asset))],
        ["choice", str("transfer_to_account")],
        ["params", `{ destination: ${str(d.to)} }`],
      ];
    case "claim":
      return [
        ["id", str(claimId(d.balanceId))],
        ["choice", str(d.addTrustline ? "add_trustline_then_claim" : "claim")],
      ];
    case "forfeit":
      return [
        ["id", str(claimId(d.balanceId))],
        ["choice", str("forfeit")],
      ];
  }
}

const memoFields = (memo: string): Field[] => [
  ["memo", str(memo)],
  ["memoType", str("id")],
];

/** A `CODE:ISSUER`-keyed record as the lines of the property `name`. */
function recordLines(
  indent: string,
  name: string,
  entries: readonly (readonly [string, Field[]])[]
): string[] {
  if (entries.length === 0) return [`${indent}${name}: {},`];
  return [
    `${indent}${name}: {`,
    ...entries.flatMap(([key, fields]) => objectLines(`${indent}  `, `${str(key)}: `, fields, ",")),
    `${indent}},`,
  ];
}

/** The statements that close one account, from the plan to the last confirmed transaction. */
function closeBody(close: SnippetClose): string[] {
  const { destination, decisions } = close;
  const exchange = destination.kind === "exchange" ? destination : null;
  const acknowledgement: Field[] = [
    ["id", str(destinationId(destination.address))],
    ["choice", str("i_control_this_address")],
  ];
  const answers = [...(exchange ? [] : [acknowledgement]), ...decisions.map(answerFields)];
  // A return to the issuer is held as a transfer to the issuer the asset names, with no floor.
  const transfers = decisions.flatMap((d): [string, Field[]][] => {
    if (d.kind === "return_to_issuer") {
      return [
        [
          canonical(d.asset),
          [
            ["destination", str(d.asset.issuer)],
            ["amount", str("0")],
          ],
        ],
      ];
    }
    if (d.kind === "transfer") {
      return [
        [
          canonical(d.asset),
          [
            ["destination", str(d.to)],
            ["amount", str(d.amount)],
          ],
        ],
      ];
    }
    return [];
  });
  const conversions = decisions.flatMap((d): [string, Field[]][] =>
    d.kind === "convert_to_xlm"
      ? [[canonical(d.asset), [["minAmountOut", str(d.minAmountOut)]]]]
      : []
  );
  const claimTrustlines = decisions.flatMap((d) =>
    d.kind === "claim" && d.addTrustline ? [str(canonical(d.addTrustline))] : []
  );
  const forfeits = decisions.some((d) => d.kind === "forfeit");
  const request: Field[] = [
    ["source"],
    ["destination"],
    ["decisions"],
    ["planHash"],
    ...(exchange ? memoFields(exchange.memo) : []),
  ];
  const prepare = [
    ...(exchange
      ? [
          '    if (parse(xdr).operations.some((op) => op.type === "accountMerge")) {',
          "      return (await client.mediatorSign(xdr)).transaction;",
          "    }",
        ]
      : []),
    ...(close.sponsored
      ? ["    if (tx.needsSponsoredFee) return (await client.feeBumpSponsor(xdr)).transaction;"]
      : []),
  ];
  const prepareParam = close.sponsored ? "tx" : "_tx";
  const multisig = close.signers.length > 0;
  const cosigners = close.signers.filter((sg) => sg.type === "ed25519_public_key");
  const cosignerEnv = cosigners.map((_, i) => `LUMENWIPE_COSIGNER_${i + 1}_SECRET`);
  const hashSigners = close.signers.filter((sg) => sg.type === "hash_x");
  const preimageEnv = hashSigners.map((_, i) => `LUMENWIPE_HASHX_PREIMAGE_${i + 1}`);
  const preAuth = close.signers.filter((sg) => sg.type === "preauth_tx");
  const preimageLines =
    hashSigners.length > 0
      ? [
          "// Each hash(x) signer's preimage, in hex, from its own variable.",
          "const preimages: { key: string; preimage: string | undefined }[] = [",
          ...hashSigners.flatMap((sg, i) =>
            objectLines(
              "  ",
              "",
              [
                ["key", str(sg.key)],
                ["preimage", `process.env.${preimageEnv[i]}`],
              ],
              ","
            )
          ),
          "];",
        ]
      : [];
  const hashXLoop =
    hashSigners.length > 0
      ? [
          "    for (const { key, preimage } of preimages) {",
          "      const keyWeight = live.signers.find((s) => s.key === key)?.weight ?? 0;",
          "      if (!preimage || weight >= required || keyWeight === 0) continue;",
          '      tx.signHashX(Buffer.from(preimage, "hex"));',
          "      weight += keyWeight;",
          "    }",
        ]
      : [];
  const keyLines = multisig
    ? [
        "",
        "// Each co-signer's secret comes from its own variable; it signs only while weight is short.",
        ...cosigners.map((sg, i) => `// ${cosignerEnv[i]} signs for ${sg.key}`),
        ...(preAuth.length > 0 ? ["// Needs no signature: the pre-authorized transaction"] : []),
        ...preAuth.map((sg) => `//   ${sg.key}`),
        ...(cosigners.length > 0
          ? [
              "const cosigners = [",
              ...cosignerEnv.map((name) => `  process.env.${name},`),
              "].flatMap((secret) => (secret ? [Keypair.fromSecret(secret)] : []));",
              "const keys = [signer, ...cosigners];",
            ]
          : ["const keys = [signer];"]),
        ...preimageLines,
        "// The signers and thresholds each round was built against.",
        'let live: Pick<typeof account, "signers" | "thresholds"> = account;',
      ]
    : [];
  const fetchLines = multisig
    ? [
        "  getTransactions: async ({ planHash }) => {",
        ...objectLines("    ", "const round = await client.closeTransactions(", request, ");"),
        "    live = round.sourceAccount ?? (await client.getAccount(source));",
        "    return round;",
        "  },",
      ]
    : [
        "  getTransactions: ({ planHash }) =>",
        ...objectLines("    ", "client.closeTransactions(", request, "),"),
      ];
  const signLines = multisig
    ? [
        "  requiredWeight: () => Math.max(1, live.thresholds.high),",
        "  sign: async (_tx, xdr) => {",
        "    const tx = parse(xdr);",
        "    const required = Math.max(1, live.thresholds.high);",
        "    let weight = 0;",
        "    for (const key of keys) {",
        "      const keyWeight = live.signers.find((s) => s.key === key.publicKey())?.weight ?? 0;",
        "      if (weight >= required || keyWeight === 0) continue;",
        "      tx.sign(key);",
        "      weight += keyWeight;",
        "    }",
        ...hashXLoop,
        "    return { xdr: tx.toXDR(), weight };",
        "  },",
      ]
    : [
        "  requiredWeight: () => account.thresholds.high,",
        "  sign: async (_tx, xdr) => {",
        "    const tx = parse(xdr);",
        "    tx.sign(signer);",
        "    const weight = account.signers.find((s) => s.key === signer.publicKey())?.weight ?? 0;",
        "    return { xdr: tx.toXDR(), weight };",
        "  },",
      ];

  return [
    `const source = ${str(close.source)};`,
    `const destination = ${str(destination.address)};`,
    "const decisions: DecisionAnswer[] = [",
    ...answers.flatMap((fields) => objectLines("  ", "", fields, ",")),
    "];",
    "",
    "const account = await client.getAccount(source);",
    "const plan = await client.closePlan({ source, destination, decisions });",
    forfeits
      ? `const blockers = plan.blockers.filter((b) => b.code !== ${str(FORFEITED_BLOCKER)});`
      : "const { blockers } = plan;",
    'if (blockers.length > 0) throw new Error(blockers.map((b) => b.message).join("; "));',
    ...keyLines,
    "",
    "await runClose({",
    "  planHash: plan.planHash,",
    ...fetchLines,
    "  verify: (tx) =>",
    "    verifyCloseTransaction({",
    "      unsignedXdr: tx.xdr,",
    "      network,",
    "      expected: {",
    "        ...exitExpectations(account, network),",
    "        source,",
    "        destination,",
    "        nativeBalance: account.nativeBalanceLumens,",
    `        memo: ${exchange ? str(exchange.memo) : "null"},`,
    `        memoType: ${exchange ? '"id"' : "null"},`,
    `        claimTrustlineAssets: [${claimTrustlines.join(", ")}],`,
    "        accountSigners: account.signers,",
    "        accountThresholds: account.thresholds,",
    ...recordLines("        ", "transfers", transfers),
    "        tokenTransfers: {},",
    ...recordLines("        ", "classicConversions", conversions),
    "        tokenConversions: {},",
    "      },",
    "    }),",
    ...signLines,
    ...(prepare.length > 0
      ? [`  prepare: async (${prepareParam}, xdr) => {`, ...prepare, "    return xdr;", "  },"]
      : []),
    "  submit: async (_tx, xdr) => (await client.submit(xdr)).hash,",
    "  onConfirmed: (tx, hash) => console.log(`${tx.intent.summary}: ${hash}`),",
    "});",
  ];
}

/**
 * The TypeScript an integrator writes to run this close through `@lumenwipe/sdk`, checking every
 * transaction with `@lumenwipe/verify` before signing it. Only public data reaches the text: the
 * API key and the signing secret are named as environment variables, never given.
 */
export function buildSdkSnippet(input: SdkSnippetInput): string {
  const { network, close } = validated(input);
  const passphrase = network === "testnet" ? "Networks.TESTNET" : "Networks.PUBLIC";
  return [
    'import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";',
    'import { LumenWipeClient, runClose, type DecisionAnswer } from "@lumenwipe/sdk";',
    'import { exitExpectations, verifyCloseTransaction } from "@lumenwipe/verify";',
    "",
    `const network = ${str(network)};`,
    "const client = new LumenWipeClient({",
    '  baseUrl: process.env.LUMENWIPE_API_URL ?? "https://api.lumenwipe.com",',
    '  apiKey: process.env.LUMENWIPE_API_KEY ?? "",',
    "  network,",
    "});",
    'const signer = Keypair.fromSecret(process.env.LUMENWIPE_SIGNING_SECRET ?? "");',
    "",
    "function parse(xdr: string): Transaction {",
    `  const tx = TransactionBuilder.fromXdr(xdr, ${passphrase});`,
    '  if (!(tx instanceof Transaction)) throw new Error("Unexpected fee-bump envelope");',
    "  return tx;",
    "}",
    "",
    ...closeBody(close),
    "",
  ].join("\n");
}

/**
 * A playground session's close as the snippet shows it, from the same expectation its demolish
 * answers every decision from (lib/demolish.ts): the destination, the memo of an exchange session,
 * each asset's and claimable balance's answer, and the signers the session added.
 */
export function snippetInputFromExpectation(expected: PlaygroundCloseExpectation): SdkSnippetInput {
  const { exchange } = expected;
  const decisions: SnippetDecision[] = expected.assets.map((held): SnippetDecision => {
    const key = canonical(held);
    const conversion = expected.conversions.find((c) => c.asset === key);
    if (conversion) {
      return { kind: "convert_to_xlm", asset: held, minAmountOut: conversion.minAmountOut };
    }
    const transfer = expected.transfers.find((t) => t.asset === key);
    if (transfer) {
      return { kind: "transfer", asset: held, to: transfer.destination, amount: transfer.amount };
    }
    return { kind: "return_to_issuer", asset: held };
  });
  for (const claim of expected.claims) {
    decisions.push({
      kind: "claim",
      balanceId: claim.id,
      addTrustline: claim.addTrustline ? assetOf(claim.asset) : null,
    });
  }
  for (const balanceId of expected.forfeits) decisions.push({ kind: "forfeit", balanceId });
  return {
    network: "testnet",
    close: {
      source: expected.demoPublic,
      destination: exchange
        ? { kind: "exchange", address: exchange.destination, memo: exchange.memo, memoType: "id" }
        : { kind: "account", address: expected.sinkPublic },
      decisions,
      signers: expected.recordedSigners,
      sponsored: expected.sponsored,
    },
  };
}
