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

describe("wallet kit imports", () => {
  const LAZY = /Load the wallet kit through lib\/wallet-kit\/loader\.ts/;
  const kitCode = [
    `import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit";\nexport const b = StellarWalletsKit;\n`,
    `import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";\nexport const b = StellarWalletsKit;\n`,
    `import { XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";\nexport const b = XBULL_ID;\n`,
  ];

  test("a static import of the kit's code fails lint in every shipped folder", async () => {
    for (const code of kitCode) {
      for (const file of [
        "lib/zz-fixture.ts",
        "hooks/zz-fixture.ts",
        "components/zz-fixture.tsx",
      ]) {
        expect({ code, file, errors: await errors(code, file) }).toMatchObject({
          errors: [expect.stringMatching(LAZY)],
        });
      }
    }
  });

  test("its types, the kit-free ids, and tests are allowed", async () => {
    const allowed = `import type { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";\nimport { KitEventType } from "@creit-tech/stellar-wallets-kit/types";\nimport { XBULL_ID } from "@/lib/wallet-kit/wallet-ids";\nexport type K = typeof StellarWalletsKit;\nexport const b = [KitEventType, XBULL_ID];\n`;
    expect(await errors(allowed, "lib/zz-fixture.ts")).toEqual([]);
    expect(await errors(kitCode[2]!, "tests/unit/zz-fixture.test.ts")).toEqual([]);
  });

  test("the module list may import the kit's modules and still builds no transaction", async () => {
    const file = "lib/wallet-kit/modules.ts";
    expect(await errors(kitCode[2]!, file)).toEqual([]);
    const operation = `import { Operation } from "@stellar/stellar-sdk";\nexport const b = Operation;\n`;
    expect(await errors(operation, file)).toEqual([
      expect.stringMatching(/apps\/web never builds a transaction/),
    ]);
  });
});

describe("pollar imports", () => {
  const LAZY = /Load the Google and GitHub sign-in through components\/api-keys\/pollar-loader\.ts/;
  const pollarCode = [
    `import { usePollar } from "@pollar/react";\nexport const b = usePollar;\n`,
    `import { PollarClient } from "@pollar/core";\nexport const b = PollarClient;\n`,
    `import PollarSignIn from "./PollarSignIn";\nexport const b = PollarSignIn;\n`,
    `import PollarSignIn from "@/components/api-keys/PollarSignIn";\nexport const b = PollarSignIn;\n`,
  ];

  test("a static import of Pollar or its sign-in fails lint in every shipped folder", async () => {
    for (const code of pollarCode) {
      for (const file of [
        "app/zz-fixture.tsx",
        "lib/zz-fixture.ts",
        "hooks/zz-fixture.ts",
        "components/api-keys/zz-fixture.tsx",
        "lib/wallet-kit/modules.ts",
      ]) {
        expect({ code, file, errors: await errors(code, file) }).toMatchObject({
          errors: [expect.stringMatching(LAZY)],
        });
      }
    }
  });

  test("their types, the lazy import, and tests are allowed", async () => {
    const allowed = `import type { PollarClient } from "@pollar/core";\nimport type { PollarSignInProps } from "./PollarSignIn";\nexport type P = PollarSignInProps & { c?: PollarClient };\nexport const load = () => import("./PollarSignIn");\n`;
    expect(await errors(allowed, "components/api-keys/zz-fixture.ts")).toEqual([]);
    expect(await errors(pollarCode[0]!, "tests/unit/zz-fixture.test.ts")).toEqual([]);
  });

  test("the sign-in may import Pollar and still loads no wallet kit statically", async () => {
    const file = "components/api-keys/PollarSignIn.tsx";
    expect(await errors(pollarCode[0]!, file)).toEqual([]);
    const kit = `import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";\nexport const b = StellarWalletsKit;\n`;
    expect(await errors(kit, file)).toEqual([
      expect.stringMatching(/Load the wallet kit through lib\/wallet-kit\/loader\.ts/),
    ]);
  });
});
