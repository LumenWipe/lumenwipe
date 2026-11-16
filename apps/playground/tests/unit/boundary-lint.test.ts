import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import path from "path";
import { ESLint } from "eslint";

const root = process.cwd();
const eslint = new ESLint({ cwd: root });

async function errors(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result!.messages.filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

const importOf = (specifier: string) =>
  `import value from "${specifier}";\nexport const used = value;\n`;

describe("app zones", () => {
  const crossings: Array<[string, string, RegExp]> = [
    ["lib/zz-fixture.ts", "../../web/lib/stellar/verify", /never by reaching into apps\/web/],
    ["app/zz-fixture.tsx", "../../web/lib/exchange-registry", /never by reaching into apps\/web/],
    ["lib/zz-fixture.ts", "../../api/src/lib/stellar/submit", /must not import apps\/api source/],
    [
      "lib/zz-fixture.ts",
      "../../api/src/config/exchange-registry.json",
      /must not import apps\/api source/,
    ],
    [
      "tests/unit/zz-fixture.test.ts",
      "../../../api/tests/unit/fixtures/soroswap-aggregator-v2-swap.json",
      /must not import apps\/api source/,
    ],
  ];
  test("an import of apps/web or apps/api source fails lint", async () => {
    for (const [file, specifier, message] of crossings) {
      expect({ file, specifier, errors: await errors(importOf(specifier), file) }).toMatchObject({
        errors: expect.arrayContaining([
          expect.stringMatching(new RegExp(`^import/no-restricted-paths: .*${message.source}`)),
        ]),
      });
    }
  });

  test("the playground's own modules and shared packages are allowed", async () => {
    for (const specifier of ["./scenarios", "@/lib/verify", "@lumenwipe/verify"]) {
      expect(await errors(importOf(specifier), "lib/zz-fixture.ts")).toEqual([]);
    }
  });
});

describe("the verifier never builds a transaction", () => {
  const BUILT = /verifier never builds a transaction/;
  const building = [
    `import { Account, TransactionBuilder } from "@stellar/stellar-sdk";\nexport const b = (a: Account) => new TransactionBuilder(a, { fee: "100" });\n`,
    `import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";\nexport const b = (tx: Transaction) => TransactionBuilder.buildFeeBumpTransaction("G", "100", tx, "p");\n`,
    `import { Operation } from "@stellar/stellar-sdk";\nexport const b = () => Operation.bumpSequence({ bumpTo: "1" });\n`,
    `import * as Sdk from "@stellar/stellar-sdk";\nexport const b = Sdk;\n`,
    `import { xdr } from "@stellar/stellar-sdk";\nexport const b = (tx: xdr.Transaction) => xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({ tx, signatures: [] }));\n`,
  ];

  test("building in a verifier file fails lint", async () => {
    for (const file of ["lib/verify.ts", "lib/verify-revoke.ts", "lib/verify-zz-fixture.ts"]) {
      for (const code of building) {
        expect({ file, code, errors: await errors(code, file) }).toMatchObject({
          errors: expect.arrayContaining([expect.stringMatching(BUILT)]),
        });
      }
    }
  });

  test("parsing in a verifier file, and building in the mess executors, are allowed", async () => {
    const parse = `import { TransactionBuilder } from "@stellar/stellar-sdk";\nexport const parse = (x: string, p: string) => TransactionBuilder.fromXDR(x, p);\n`;
    expect(await errors(parse, "lib/verify-zz-fixture.ts")).toEqual([]);
    expect(await errors(building[0]!, "lib/zz-fixture.ts")).toEqual([]);
    expect(await errors(building[2]!, "lib/zz-fixture.ts")).toEqual([]);
  });
});

describe("the verifier and the mess executors never import each other", () => {
  const ISOLATED = /^no-restricted-imports: .*The verifier never imports the mess executors/;
  const NOT_THE_VERIFIER = /^no-restricted-imports: .*never import the verifier/;
  const verifiers = [
    ...readdirSync(path.join(root, "lib"))
      .filter((name) => name.startsWith("verify") && name.endsWith(".ts"))
      .map((name) => `lib/${name}`),
    "lib/verify-zz-fixture.ts",
  ];
  const executors = [
    "./mess-builders",
    "./soroban-seed",
    "./soroban-submit",
    "@/lib/soroban-submit",
    "./horizon-submit",
  ];

  test("the files checked are every verifier on disk, the revoke verifier included", () => {
    expect(verifiers).toEqual(
      expect.arrayContaining(
        ["", "-error", "-feebump", "-mediator", "-revoke", "-soroban"].map(
          (suffix) => `lib/verify${suffix}.ts`
        )
      )
    );
  });

  test("an executor or submission import in any verifier file fails lint", async () => {
    for (const file of verifiers) {
      for (const specifier of executors) {
        expect({ file, specifier, errors: await errors(importOf(specifier), file) }).toMatchObject({
          errors: expect.arrayContaining([expect.stringMatching(ISOLATED)]),
        });
      }
    }
  });

  test("the revoke verifier importing the Soroban submit path fails lint", async () => {
    expect(await errors(importOf("./soroban-submit"), "lib/verify-revoke.ts")).toEqual([
      expect.stringMatching(ISOLATED),
    ]);
  });

  test("a verifier may import the fee policy, the scenarios and the shared verifier", async () => {
    for (const specifier of ["./fee-policy", "./scenarios", "@lumenwipe/verify"]) {
      expect(await errors(importOf(specifier), "lib/verify-revoke.ts")).toEqual([]);
    }
  });

  test("a mess executor importing any verifier file fails lint", async () => {
    for (const file of ["lib/mess-builders.ts", "lib/soroban-seed.ts", "lib/soroban-submit.ts"]) {
      for (const specifier of ["./verify", "./verify-revoke", "@/lib/verify-zz-fixture"]) {
        expect({ file, specifier, errors: await errors(importOf(specifier), file) }).toMatchObject({
          errors: expect.arrayContaining([expect.stringMatching(NOT_THE_VERIFIER)]),
        });
      }
    }
  });
});
