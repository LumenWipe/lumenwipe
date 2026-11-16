import { describe, expect, test } from "bun:test";
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
