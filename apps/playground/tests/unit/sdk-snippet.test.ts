import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildSdkSnippet,
  SdkSnippetInputError,
  snippetInputFromExpectation,
  type SdkSnippetInput,
  type SnippetClose,
} from "@/lib/sdk-snippet";
import { handleSdkSnippet } from "@/lib/route-handlers";
import { resolvePlan, EXCHANGE_STAND_IN, type ScenarioSelection } from "@/lib/scenarios";
import type { NewSessionData } from "@/lib/session-store";
import { expectationFromSession } from "@/lib/verify";
import { memoryStore, newSessionData } from "./session-fixtures";

// The snippet is held to the SDK's public entry and to @lumenwipe/verify's public types by the
// TypeScript compiler, so a method, a field or a hook shape the packages do not have fails here.

const ROOT = path.resolve(import.meta.dir, "../../../..");
const at = (...parts: string[]): string => path.join(ROOT, ...parts);
const SNIPPET_DIR = at("apps/playground/tests/unit/.sdk-snippet");

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  types: ["node"],
  resolveJsonModule: true,
  esModuleInterop: true,
  paths: {
    "@lumenwipe/sdk": [at("packages/sdk/src/index.ts")],
    "@lumenwipe/types": [at("packages/types/src/index.ts")],
    "@lumenwipe/verify": [at("packages/verify/src/index.ts")],
    // The aliases the web modules behind the verifier's facade import through.
    "@/*": [at("apps/web/*")],
    "@registry/*": [at("apps/api/src/config/*")],
  },
};

/** Every compiler diagnostic for each snippet, type-checked together in one program. */
function diagnostics(snippets: readonly string[]): string[][] {
  const files = new Map(snippets.map((text, i) => [path.join(SNIPPET_DIR, `case-${i}.ts`), text]));
  const host = ts.createCompilerHost(OPTIONS);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) => {
    const text = files.get(name);
    return text === undefined
      ? getSourceFile(name, language, ...rest)
      : ts.createSourceFile(name, text, language);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => files.has(name) || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? readFile(name);
  const program = ts.createProgram([...files.keys()], OPTIONS, host);
  // The public entries themselves must resolve cleanly, or a broken import would type the snippet
  // against `any` and let anything through.
  for (const entry of ["packages/sdk/src/index.ts", "packages/verify/src/index.ts"]) {
    const source = program.getSourceFile(at(entry));
    if (!source) throw new Error(`${entry} is not in the program`);
    const own = ts.getPreEmitDiagnostics(program, source).map(explain);
    if (own.length > 0) throw new Error(`${entry} does not type-check:\n${own.join("\n")}`);
  }
  return [...files.keys()].map((name) =>
    ts.getPreEmitDiagnostics(program, program.getSourceFile(name)).map(explain)
  );
}

function explain(d: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return message;
  const { line } = d.file.getLineAndCharacterOfPosition(d.start);
  return `line ${line + 1}: ${message}`;
}

const account = (): string => Keypair.random().publicKey();
const balanceId = (): string => `00000000${randomBytes(32).toString("hex")}`;
const STRKEY_SECRET = /S[A-Z2-7]{55}/;

function close(overrides: Partial<SnippetClose> = {}): SnippetClose {
  return {
    source: account(),
    destination: { kind: "account", address: account() },
    decisions: [],
    sponsored: false,
    ...overrides,
  };
}

const plain: SdkSnippetInput = { network: "testnet", close: close() };
const exchange: SdkSnippetInput = {
  network: "testnet",
  close: close({
    destination: {
      kind: "exchange",
      address: account(),
      memo: "8411204470115328731",
      memoType: "id",
    },
    decisions: [{ kind: "return_to_issuer", asset: { code: "LWDEMO", issuer: account() } }],
  }),
};
const withDecisions: SdkSnippetInput = {
  network: "testnet",
  close: close({
    sponsored: true,
    decisions: [
      { kind: "return_to_issuer", asset: { code: "LWDEMO", issuer: account() } },
      {
        kind: "convert_to_xlm",
        asset: { code: "LWCOIN", issuer: account() },
        minAmountOut: "4950000",
      },
      {
        kind: "transfer",
        asset: { code: "LWGEM", issuer: account() },
        to: account(),
        amount: "25",
      },
      { kind: "claim", balanceId: balanceId(), addTrustline: { code: "GIFT", issuer: account() } },
      { kind: "claim", balanceId: balanceId(), addTrustline: null },
      { kind: "forfeit", balanceId: balanceId() },
    ],
  }),
};

describe("the generated snippet", () => {
  test("type-checks against the SDK and verifier public types, with no diagnostic", () => {
    const snippets = [plain, exchange, withDecisions].map(buildSdkSnippet);
    expect(diagnostics(snippets)).toEqual([[], [], []]);
  });

  test("calls the client, then closePlan, then runClose with a verify and a sign hook", () => {
    const text = buildSdkSnippet(plain);
    const order = ["new LumenWipeClient(", "client.closePlan(", "await runClose({"];
    const positions = order.map((call) => text.indexOf(call));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain("verifyCloseTransaction({");
    expect(text).toContain("sign: async (_tx, xdr) => {");
  });

  test("names the API key and the signing secret as environment variables only", () => {
    const text = buildSdkSnippet(withDecisions);
    expect(text).toContain("process.env.LUMENWIPE_API_KEY");
    expect(text).toContain("process.env.LUMENWIPE_SIGNING_SECRET");
    expect(text).not.toMatch(STRKEY_SECRET);
  });

  test("an exchange close carries its memo to the API and to the verifier", () => {
    const text = buildSdkSnippet(exchange);
    const memo = '"8411204470115328731"';
    expect(text).toContain(`memo: ${memo},\n      memoType: "id",\n    }),`);
    expect(text).toContain(`memo: ${memo},\n        memoType: "id",`);
    expect(text).toContain("client.mediatorSign(xdr)");
    expect(text).not.toContain("i_control_this_address");
  });

  test("a close to an account carries no memo, and acknowledges the destination", () => {
    const text = buildSdkSnippet(plain);
    expect(text).toContain("memo: null,");
    expect(text).not.toContain('memoType: "id"');
    expect(text).toContain(`id: "destination:${plain.close.destination.address}"`);
    expect(text).not.toContain("mediatorSign");
  });

  test("a forfeited balance's blocker is the only one the snippet closes past", () => {
    expect(buildSdkSnippet(withDecisions)).toContain(
      'plan.blockers.filter((b) => b.code !== "claimable_balance_forfeited")'
    );
    expect(buildSdkSnippet(plain)).toContain("const { blockers } = plan;");
  });
});

describe("the snippet input", () => {
  const secret = (): string => Keypair.random().secret();

  test("a secret key passed as an address is refused", () => {
    const issuer = secret();
    const cases: SdkSnippetInput[] = [
      { network: "testnet", close: close({ source: secret() }) },
      { network: "testnet", close: close({ destination: { kind: "account", address: secret() } }) },
      {
        network: "testnet",
        close: close({
          decisions: [{ kind: "return_to_issuer", asset: { code: "LWDEMO", issuer } }],
        }),
      },
      {
        network: "testnet",
        close: close({
          decisions: [
            {
              kind: "transfer",
              asset: { code: "LWGEM", issuer: account() },
              to: secret(),
              amount: "1",
            },
          ],
        }),
      },
    ];
    for (const input of cases) {
      expect(() => buildSdkSnippet(input)).toThrow(SdkSnippetInputError);
    }
  });

  test("anything that would not print as a plain literal is refused", () => {
    const bad = [
      close({
        destination: { kind: "exchange", address: account(), memo: '1"; x', memoType: "id" },
      }),
      close({
        destination: {
          kind: "exchange",
          address: account(),
          memo: "18446744073709551616",
          memoType: "id",
        },
      }),
      close({ decisions: [{ kind: "forfeit", balanceId: "not-a-balance" }] }),
      close({
        decisions: [{ kind: "return_to_issuer", asset: { code: "A B", issuer: account() } }],
      }),
      close({
        decisions: [
          {
            kind: "convert_to_xlm",
            asset: { code: "LWCOIN", issuer: account() },
            minAmountOut: "0",
          },
        ],
      }),
    ];
    for (const c of bad) {
      expect(() => buildSdkSnippet({ network: "testnet", close: c })).toThrow(SdkSnippetInputError);
    }
  });
});

describe("a playground session's snippet", () => {
  const SELECTION: ScenarioSelection = resolvePlan({
    scenarios: [
      { id: "lwdemo-holding", params: {} },
      { id: "dispositions", params: { lwcoin: 1, lwgem: 2 } },
      { id: "claimable-balances", params: { add_trustline: 1, time_gated: 1 } },
      { id: "exchange-close", params: {} },
    ],
  }).selection;
  const ENCRYPTED = () => `enc:${randomBytes(24).toString("base64")}`;

  function sessionData(): { data: NewSessionData; sink: string; issuer: string } {
    const ephemeralIssuers = resolvePlan(SELECTION).ephemeralAssets.map((assetCode) => ({
      assetCode,
      publicKey: account(),
      encSecret: ENCRYPTED(),
    }));
    const issuerOf = (code: string): string =>
      ephemeralIssuers.find((e) => e.assetCode === code)!.publicKey;
    return {
      sink: account(),
      issuer: account(),
      data: {
        ...newSessionData(),
        demoPublic: account(),
        encDemoSecret: ENCRYPTED(),
        ephemeralIssuers,
        selection: SELECTION,
        transferRecipient: { publicKey: account(), encSecret: ENCRYPTED() },
        claimableBalances: [
          { id: balanceId(), asset: `BONUS:${issuerOf("BONUS")}`, intent: "claim" },
          {
            id: balanceId(),
            asset: `GIFT:${issuerOf("GIFT")}`,
            intent: "add_trustline_then_claim",
          },
          { id: balanceId(), asset: "native", intent: "forfeit" },
        ],
        exchange: { destination: EXCHANGE_STAND_IN.address, memo: "4242424242", memoType: "id" },
      },
    };
  }

  test("answers what the session's demolish answers, and compiles", () => {
    const { data, sink, issuer } = sessionData();
    const expected = expectationFromSession(data, sink, issuer, null);
    const input = snippetInputFromExpectation(expected);
    const text = buildSdkSnippet(input);

    expect(input.close.source).toBe(data.demoPublic);
    expect(input.close.destination).toEqual({
      kind: "exchange",
      address: EXCHANGE_STAND_IN.address,
      memo: "4242424242",
      memoType: "id",
    });
    for (const conversion of expected.conversions) {
      expect(text).toContain(
        `"${conversion.asset}": {\n            minAmountOut: "${conversion.minAmountOut}",`
      );
    }
    for (const transfer of expected.transfers) {
      expect(text).toContain(`destination: "${transfer.destination}"`);
    }
    for (const claim of data.claimableBalances) {
      expect(text).toContain(`id: "claim:${claim.id}"`);
    }
    const gift = data.claimableBalances.find((b) => b.intent === "add_trustline_then_claim")!;
    expect(text).toContain(`claimTrustlineAssets: [${JSON.stringify(gift.asset)}],`);
    expect(diagnostics([text])).toEqual([[]]);
  });

  test("holds no secret and nothing from the session's encrypted fields", () => {
    const { data, sink, issuer } = sessionData();
    const text = buildSdkSnippet(
      snippetInputFromExpectation(expectationFromSession(data, sink, issuer, null))
    );
    const encrypted = [
      data.encDemoSecret,
      ...data.ephemeralIssuers.map((e) => e.encSecret),
      data.transferRecipient!.encSecret,
    ];
    for (const value of encrypted) expect(text).not.toContain(value);
    expect(text).not.toMatch(STRKEY_SECRET);
  });

  test("the route serves it for a stored session, and is not configured without the accounts", async () => {
    const store = memoryStore();
    const { data, sink, issuer } = sessionData();
    const session = await store.createSession(data);

    const res = await handleSdkSnippet(session.id, {
      store,
      publicAccounts: () => ({ sink, issuer }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snippet: string };
    expect(body.snippet).toBe(
      buildSdkSnippet(snippetInputFromExpectation(expectationFromSession(data, sink, issuer, null)))
    );

    const unconfigured = await handleSdkSnippet(session.id, { store, publicAccounts: () => null });
    expect(unconfigured.status).toBe(503);
  });
});
