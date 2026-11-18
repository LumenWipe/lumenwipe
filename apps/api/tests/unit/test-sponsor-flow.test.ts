import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { actsForOneAccount, isAllowedWindDownOperation } from "@/fee-bump/fee-bump-validation";
import { validityProblem } from "@/lib/stellar/validity-window";
import { buildSponsoredClose, main } from "../../scripts/test-sponsor-flow";

const SEED = /\bS[A-Z2-7]{55}\b/;

interface FakeOptions {
  /** The key the fake endpoint signs fee bumps with. */
  sponsor: Keypair;
  sponsorStatus?: number;
  feeAccountOnHorizon?: string;
  sourceSurvives?: boolean;
}

function fakeNetwork(opts: FakeOptions) {
  const calls: string[] = [];
  let submitted: Transaction | null = null;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("https://friendbot.stellar.org/")) return json({});
    if (url.endsWith("/api/testnet/fee-bump/sponsor")) {
      if (opts.sponsorStatus) {
        return json({ error: { code: "fee_sponsorship_paused" } }, opts.sponsorStatus);
      }
      const { transaction } = JSON.parse(String(init!.body)) as { transaction: string };
      const inner = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as Transaction;
      const bump = TransactionBuilder.buildFeeBumpTransaction(
        opts.sponsor,
        "200",
        inner,
        Networks.TESTNET
      );
      bump.sign(opts.sponsor);
      return json({ transaction: bump.toEnvelope().toXDR("base64") });
    }
    if (url === "https://horizon-testnet.stellar.org/transactions") {
      const tx = new URLSearchParams(String(init!.body)).get("tx")!;
      const bump = TransactionBuilder.fromXDR(tx, Networks.TESTNET);
      submitted = (bump as unknown as { innerTransaction: Transaction }).innerTransaction;
      return json({ successful: true, hash: "ab".repeat(32) });
    }
    if (url.startsWith("https://horizon-testnet.stellar.org/transactions/")) {
      return json({
        fee_account: opts.feeAccountOnHorizon ?? opts.sponsor.publicKey(),
        source_account: submitted!.source,
      });
    }
    if (url.startsWith("https://horizon-testnet.stellar.org/accounts/")) {
      if (submitted && !opts.sourceSurvives && url.endsWith(submitted.source)) {
        return json({ status: 404 }, 404);
      }
      return json({ sequence: "4294967296" });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchFn, calls };
}

async function run(env: Record<string, string>, opts: FakeOptions) {
  const net = fakeNetwork(opts);
  const out: string[] = [];
  const err: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  const code = await main({ APP_URL: "http://app.test", ...env }, net.fetchFn, (line) =>
    out.push(line)
  );
  return { code, out, err, calls: net.calls };
}

afterEach(() => {
  (process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("buildSponsoredClose", () => {
  test("builds a transaction the sponsor endpoint accepts", () => {
    const source = Keypair.random().publicKey();
    const tx = buildSponsoredClose(source, "10", Keypair.random().publicKey());
    expect(tx.fee).toBe("0");
    expect(tx.sequence).toBe("11");
    expect(tx.operations.map((op) => op.type)).toEqual(["accountMerge"]);
    expect(tx.operations.every(isAllowedWindDownOperation)).toBe(true);
    expect(actsForOneAccount(tx)).toBe(true);
    expect(validityProblem(tx, new Date())).toBeNull();
  });
});

describe("main", () => {
  test("passes when the expected sponsor pays the fee, printing no seed", async () => {
    const sponsor = Keypair.random();
    const r = await run({ FEE_ACCOUNT_ADDRESS_TESTNET: sponsor.publicKey() }, { sponsor });
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toStartWith(`PASS: fee_account ${sponsor.publicKey()}`);
    expect(r.calls).toContain("POST http://app.test/api/testnet/fee-bump/sponsor");
    expect([...r.out, ...r.err].join("\n")).not.toMatch(SEED);
  });

  test("fails before submitting when another account pays the fee", async () => {
    const expected = Keypair.random().publicKey();
    const r = await run({ FEE_ACCOUNT_ADDRESS_TESTNET: expected }, { sponsor: Keypair.random() });
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain(`not ${expected}`);
    expect(r.calls).not.toContain("POST https://horizon-testnet.stellar.org/transactions");
  });

  test("fails when Horizon reports another fee account", async () => {
    const sponsor = Keypair.random();
    const r = await run(
      { FEE_ACCOUNT_ADDRESS_TESTNET: sponsor.publicKey() },
      { sponsor, feeAccountOnHorizon: Keypair.random().publicKey() }
    );
    expect(r.code).toBe(1);
    expect(r.err[0]).toStartWith("FAIL: Horizon shows fee_account");
  });

  test("fails when the source account survives the merge", async () => {
    const sponsor = Keypair.random();
    const r = await run(
      { FEE_ACCOUNT_ADDRESS_TESTNET: sponsor.publicKey() },
      { sponsor, sourceSurvives: true }
    );
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe("FAIL: the source account still exists after the merge\n");
  });

  test("fails with the status when the endpoint refuses", async () => {
    const sponsor = Keypair.random();
    const r = await run(
      { FEE_ACCOUNT_ADDRESS_TESTNET: sponsor.publicKey() },
      { sponsor, sponsorStatus: 503 }
    );
    expect(r.code).toBe(1);
    expect(r.err[0]).toStartWith("FAIL: fee-bump/sponsor answered 503");
  });

  test("fails without a request when the expected sponsor is not an address", async () => {
    const r = await run({ FEE_ACCOUNT_ADDRESS_TESTNET: "" }, { sponsor: Keypair.random() });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("FEE_ACCOUNT_ADDRESS_TESTNET");
    expect(r.calls).toEqual([]);
  });
});
