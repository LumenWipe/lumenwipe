import { describe, expect, test } from "bun:test";
import path from "path";
import { ESLint } from "eslint";
import { DICTIONARY_COPY } from "../../eslint.config.mjs";

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
    ["lib/zz-fixture.ts", "../../api/src/lib/stellar/submit", /must not import apps\/api/],
    ["lib/zz-fixture.ts", "../../api/src/config/networks", /must not import apps\/api/],
    ["lib/zz-fixture.ts", "@registry/networks", /must not import apps\/api/],
    ["lib/zz-fixture.ts", "@registry/validate-env", /must not import apps\/api/],
    [
      "components/zz-fixture.tsx",
      "../../playground/lib/verify",
      /must not import apps\/playground/,
    ],
    [
      "tests/unit/zz-fixture.test.ts",
      "../../../api/tests/unit/fixtures/soroswap-aggregator-v2-swap.json",
      /must not import apps\/api/,
    ],
    ["tests/unit/zz-fixture.test.ts", "@registry/networks", /must not import apps\/api/],
  ];
  test("an import of apps/api or apps/playground source fails lint, by path or by alias", async () => {
    for (const [file, specifier, message] of crossings) {
      expect({ file, specifier, errors: await errors(importOf(specifier), file) }).toEqual({
        file,
        specifier,
        errors: [
          expect.stringMatching(new RegExp(`^import/no-restricted-paths: .*${message.source}`)),
        ],
      });
    }
  });

  test("the two registry files are the one exception, by alias or by path", async () => {
    for (const specifier of [
      "@registry/exchange-registry.json",
      "@registry/contract-registry.json",
    ]) {
      expect(await errors(importOf(specifier), "lib/zz-fixture.ts")).toEqual([]);
      expect(await errors(importOf(specifier), "tests/unit/zz-fixture.test.ts")).toEqual([]);
    }
    expect(
      await errors(importOf("../../api/src/config/contract-registry.json"), "lib/zz-fixture.ts")
    ).toEqual([]);
  });

  test("the web's own modules and shared packages are allowed", async () => {
    for (const specifier of ["@/lib/stellar/verify", "../lib/stellar/verify", "@lumenwipe/sdk"]) {
      expect(await errors(importOf(specifier), "app/zz-fixture.ts")).toEqual([]);
    }
  });
});

describe("transaction construction", () => {
  const BUILT = /apps\/web never builds a transaction/;
  const building: Record<string, string> = {
    newBuilder: `import { Account, TransactionBuilder } from "@stellar/stellar-sdk";\nexport const b = (a: Account) => new TransactionBuilder(a, { fee: "100" });\n`,
    feeBump: `import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";\nexport const b = (tx: Transaction) => TransactionBuilder.buildFeeBumpTransaction("G", "100", tx, "p");\n`,
    clone: `import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";\nexport const b = (tx: Transaction) => TransactionBuilder.cloneFrom(tx);\n`,
    renamed: `import { TransactionBuilder as Parser } from "@stellar/stellar-sdk";\nexport const b = Parser;\n`,
    namespace: `import * as Sdk from "@stellar/stellar-sdk";\nexport const b = Sdk;\n`,
    defaultImport: `import Sdk from "@stellar/stellar-sdk";\nexport const b = Sdk;\n`,
    dynamicImport: `export const b = () => import("@stellar/stellar-sdk");\n`,
    operation: `import { Operation } from "@stellar/stellar-sdk";\nexport const b = () => Operation.bumpSequence({ bumpTo: "1" });\n`,
    contract: `import { Contract } from "@stellar/stellar-sdk/minimal";\nexport const b = (id: string) => new Contract(id).call("f");\n`,
    rawEnvelope: `import { xdr } from "@stellar/stellar-sdk";\nexport const b = (tx: xdr.Transaction) => xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({ tx, signatures: [] }));\n`,
    rawOperation: `import { xdr } from "@stellar/stellar-sdk";\nexport const b = () => xdr.OperationBody.inflation();\n`,
  };
  const shipped = [
    "lib/zz-fixture.ts",
    "lib/cosign/zz-fixture.ts",
    "hooks/zz-fixture.ts",
    "app/zz-fixture.tsx",
    "components/zz-fixture.tsx",
    "components/ui/zz-fixture.tsx",
    "app/(marketing)/zz-fixture.tsx",
    ...DICTIONARY_COPY.slice(0, 1),
    DICTIONARY_COPY.find((file) => file.startsWith("lib/"))!,
  ];

  test("building a transaction fails lint in every shipped folder", async () => {
    for (const [name, code] of Object.entries(building)) {
      for (const file of shipped) {
        expect({ name, file, errors: await errors(code, file) }).toMatchObject({
          errors: expect.arrayContaining([expect.stringMatching(BUILT)]),
        });
      }
    }
  });

  test("parsing what the API built is allowed", async () => {
    const code = `import { TransactionBuilder, xdr, type Operation } from "@stellar/stellar-sdk";\nexport const parse = (x: string, p: string) => TransactionBuilder.fromXDR(x, p);\nexport const envelope = (x: string) => xdr.TransactionEnvelope.fromXDR(x, "base64");\nexport const body = (x: string) => xdr.OperationBody.fromXDR(x, "base64");\nexport type Op = Operation;\n`;
    expect(await errors(code, "lib/zz-fixture.ts")).toEqual([]);
  });

  test("lib/cosign/merge.ts may only re-wrap a body with signatures", async () => {
    expect(await errors(building.rawEnvelope!, "lib/cosign/merge.ts")).toEqual([]);
    for (const name of ["newBuilder", "feeBump", "namespace", "operation"]) {
      expect(await errors(building[name]!, "lib/cosign/merge.ts")).toEqual(
        expect.arrayContaining([expect.stringMatching(BUILT)])
      );
    }
  });

  test("tests and seeding scripts may build transactions", async () => {
    for (const file of ["tests/unit/zz-fixture.test.ts", "scripts/zz-fixture.ts"]) {
      expect(await errors(building.newBuilder!, file)).toEqual([]);
      expect(await errors(building.operation!, file)).toEqual([]);
    }
  });
});
