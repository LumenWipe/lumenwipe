import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { Asset, Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { executeMessStep } from "@/lib/mess-builders";
import {
  maxOfferCount,
  selectionForMode,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
} from "@/lib/mess-plan";
import { handleCreateSession, handleMess } from "@/lib/route-handlers";
import {
  JUNK_OFFERS,
  SCENARIOS,
  resolvePlan,
  validateSelection,
  type MessStepId,
  type ScenarioSelection,
} from "@/lib/scenarios";
import { expectationFromSession, maxOperations } from "@/lib/verify";
import { memoryStore } from "./session-fixtures";

// The plan a visitor sees (and the scene animates), what the executor posts on chain, and what the
// verifier will let the close remove must all agree. Each case goes through the real create and
// mess handlers and the real executor, with only the network replaced: the signed transactions are
// captured and decoded instead of sent. Keys are generated per run; the "encryption" is a
// reversible stand-in.

const ORIGIN = "http://localhost:3002";
const encrypt = (plaintext: string): string => Buffer.from(plaintext, "utf8").toString("base64");
const decrypt = (payload: string): string => Buffer.from(payload, "base64").toString("utf8");

interface Posted {
  stepId: MessStepId;
  tx: Transaction;
}

const issuer = Keypair.random();
const mm = Keypair.random();

async function runAndCheck(selection: ScenarioSelection): Promise<void> {
  const store = memoryStore();
  const created = await handleCreateSession(
    new NextRequest(new URL("/api/session", ORIGIN), {
      method: "POST",
      body: JSON.stringify({ selection }),
    }),
    {
      store,
      rateLimit: async () => null,
      issuer: () => issuer,
      mm: () => mm,
      fundAccount: async () => true,
      ensureMmOffer: async () => {},
      encrypt,
    }
  );
  expect(created.status).toBe(200);
  const { sessionId, demoPublic } = (await created.json()) as {
    sessionId: string;
    demoPublic: string;
  };
  const plan = resolvePlan(selection);

  const posted: Posted[] = [];
  for (const step of plan.steps) {
    const res = await handleMess(
      new NextRequest(new URL(`/api/session/${sessionId}/mess`, ORIGIN), {
        method: "POST",
        body: JSON.stringify({ stepId: step.id }),
      }),
      sessionId,
      {
        store,
        issuer: () => issuer,
        mm: () => mm,
        decrypt,
        executeMessStep: (planned, ctx) =>
          executeMessStep(planned, ctx, {
            loadAccount: async () => ({ sequenceNumber: () => "100" }),
            submit: async (signedXdr) => {
              const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
              if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
              posted.push({ stepId: planned.id, tx });
              return { txHash: Buffer.from(tx.hash()).toString("hex") };
            },
            sleep: async () => {},
          }),
      }
    );
    expect(res.status).toBe(200);
  }

  const session = (await store.loadSession(sessionId))!;
  const expected = expectationFromSession(session, mm.publicKey(), issuer.publicKey());
  assertConsistent({ plan, demoPublic, posted, expected, issuers: session.ephemeralIssuers });
}

const label = (asset: Asset): string => (asset.isNative() ? "native" : asset.getCode());

function assertConsistent({
  plan,
  demoPublic,
  posted,
  expected,
  issuers,
}: {
  plan: ReturnType<typeof resolvePlan>;
  demoPublic: string;
  posted: Posted[];
  expected: ReturnType<typeof expectationFromSession>;
  issuers: { assetCode: string; publicKey: string }[];
}): void {
  // Every plan step posted exactly one transaction, in plan order.
  expect(posted.map((p) => p.stepId)).toEqual(plan.steps.map((s) => s.id));
  const nodes = (kind: string): string[] =>
    plan.steps.flatMap((s) => s.nodes.filter((n) => n.kind === kind).map((n) => n.id));

  const trusted = new Set<string>(["native"]);
  const trustlines: string[] = [];
  const createdIssuers: string[] = [];
  const dataNames: string[] = [];
  const offerNodes: string[] = [];
  const airdrops: string[] = [];
  let signersAdded = 0;

  for (const { stepId, tx } of posted) {
    for (const op of tx.operations) {
      const source = op.source ?? tx.source;
      switch (op.type) {
        case "createAccount":
          createdIssuers.push(op.destination);
          break;
        case "changeTrust":
          expect(source).toBe(demoPublic);
          if (op.line instanceof Asset) {
            trusted.add(label(op.line));
            trustlines.push(label(op.line));
          }
          break;
        case "manageData":
          expect(source).toBe(demoPublic);
          dataNames.push(`data:${op.name}`);
          break;
        case "manageSellOffer": {
          if (source !== demoPublic) break; // a swap counterparty's offer, not one the demo keeps
          for (const asset of [op.selling, op.buying]) expect(trusted.has(label(asset))).toBe(true);
          const index = JUNK_OFFERS.findIndex(
            (o) => o.selling === label(op.selling) && o.buying === label(op.buying)
          );
          offerNodes.push(`offer:${index}`);
          break;
        }
        case "payment":
          if (op.destination !== demoPublic) break;
          expect(trusted.has(label(op.asset))).toBe(true);
          if (stepId === "FUND_RARE") airdrops.push(`tl:${label(op.asset)}`);
          break;
        case "pathPaymentStrictReceive":
          if (op.destination === demoPublic) expect(trusted.has(label(op.destAsset))).toBe(true);
          break;
        case "setOptions":
          expect(source).toBe(demoPublic);
          if (op.signer) signersAdded++;
          break;
      }
    }
  }

  // The plan's scene nodes are what the chain received.
  expect(trustlines.map((code) => `tl:${code}`).sort()).toEqual(nodes("trustline").sort());
  expect(dataNames).toEqual(nodes("data"));
  expect(offerNodes).toEqual(nodes("offer"));
  expect(signersAdded).toBe(nodes("signer").length);
  const fundRare = plan.steps.find((s) => s.id === "FUND_RARE");
  expect(airdrops).toEqual(fundRare ? fundRare.balances.map((b) => b.nodeId) : []);
  expect(createdIssuers).toEqual(issuers.map((i) => i.publicKey));
  expect(issuers.map((i) => i.assetCode)).toEqual(plan.ephemeralAssets);

  // The verifier's expectation counts exactly the entries the chain received.
  expect(expected.assets.map((a) => a.code).sort()).toEqual([...trustlines].sort());
  expect(expected.offerCount).toBe(offerNodes.length);
  expect(expected.dataEntryCount).toBe(dataNames.length);
  expect(expected.recordedSigners).toHaveLength(signersAdded);

  // The close of these entries: a return and a removal per trustline, one operation per offer,
  // data entry and signer. The scenarios must declare exactly that, and the verifier's ceiling
  // must allow exactly that plus the threshold reset and the merge.
  const closeOps = 2 * trustlines.length + offerNodes.length + dataNames.length + signersAdded;
  expect(plan.expectation.closeOperations).toBe(closeOps);
  expect(maxOperations(expected)).toBe(closeOps + 2);
}

function* customConfigs(): Generator<PlaygroundCustomConfig> {
  for (let trustlineCount = 1; trustlineCount <= 5; trustlineCount++) {
    for (let offerCount = 0; offerCount <= maxOfferCount(trustlineCount); offerCount++) {
      for (let dataEntryCount = 0; dataEntryCount <= 5; dataEntryCount++) {
        for (const addSigner of [false, true]) {
          yield { trustlineCount, offerCount, dataEntryCount, addSigner };
        }
      }
    }
  }
}

/** Every subset of the registry, each with every parameter at its minimum and then its maximum. */
function* registrySelections(): Generator<ScenarioSelection> {
  for (let mask = 1; mask < 1 << SCENARIOS.length; mask++) {
    const picked = SCENARIOS.filter((_, i) => mask & (1 << i));
    for (const end of ["min", "max"] as const) {
      const selection: ScenarioSelection = {
        scenarios: picked.map((def) => ({
          id: def.id,
          params: Object.fromEntries(
            Object.entries(def.params).map(([name, spec]) => [name, spec[end]])
          ),
        })),
      };
      if (validateSelection(selection).ok) yield selection;
    }
  }
}

describe("the plan, the chain and the close expectation agree", () => {
  for (const mode of ["light", "standard", "full"] as const satisfies PlaygroundMode[]) {
    test(`${mode} mode`, async () => {
      await runAndCheck(selectionForMode(mode));
    });
  }

  test("every custom configuration", async () => {
    let cases = 0;
    for (const config of customConfigs()) {
      await runAndCheck(selectionForMode("custom", config));
      cases++;
    }
    expect(cases).toBe(240);
  }, 120_000);

  test("every subset of the registry at its smallest and largest parameters", async () => {
    let cases = 0;
    for (const selection of registrySelections()) {
      await runAndCheck(selection);
      cases++;
    }
    // 59 subsets are valid at their minimum (stale offers needs a token); 35 of them still are at
    // their maximum, where five offers need every token.
    expect(cases).toBe(94);
  }, 120_000);
});
