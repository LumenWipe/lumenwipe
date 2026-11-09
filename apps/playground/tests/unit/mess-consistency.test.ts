import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  Asset,
  Keypair,
  Networks,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { executeMessStep } from "@/lib/mess-builders";
import {
  maxOfferCount,
  type MessStepDef,
  type MessStepId,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
} from "@/lib/mess-plan";
import { handleCreateSession, handleMess } from "@/lib/route-handlers";
import { memoryStore } from "./session-fixtures";

// The plan a visitor sees (and the scene animates) must be what the executor posts on chain. Each
// case goes through the real create and mess handlers and the real executor, with only the
// network replaced: the executor's signed transactions are captured and decoded instead of sent.
// Keys are generated per run; the "encryption" is a reversible stand-in.

const ORIGIN = "http://localhost:3002";
const encrypt = (plaintext: string): string => Buffer.from(plaintext, "utf8").toString("base64");
const decrypt = (payload: string): string => Buffer.from(payload, "base64").toString("utf8");

interface Posted {
  stepId: MessStepId;
  tx: Transaction;
}

interface RunResult {
  plan: MessStepDef[];
  demoPublic: string;
  fundRareAssets: string[];
  posted: Posted[];
}

const issuer = Keypair.random();
const mm = Keypair.random();

async function runRecipe(
  mode: PlaygroundMode,
  customConfig?: PlaygroundCustomConfig
): Promise<RunResult> {
  const store = memoryStore();
  const created = await handleCreateSession(
    new NextRequest(new URL("/api/session", ORIGIN), {
      method: "POST",
      body: JSON.stringify({ mode, customConfig }),
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
  const { sessionId, demoPublic, messPlan } = (await created.json()) as {
    sessionId: string;
    demoPublic: string;
    messPlan: MessStepDef[];
  };
  const fundRareAssets = (await store.loadSession(sessionId))!.fundRareAssets;

  const posted: Posted[] = [];
  for (const step of messPlan) {
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
        executeMessStep: (stepId, ctx) =>
          executeMessStep(stepId, ctx, {
            loadAccount: async () => ({ sequenceNumber: () => "100" }),
            submit: async (signedXdr) => {
              const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
              posted.push({ stepId, tx });
              return { txHash: Buffer.from(tx.hash()).toString("hex") };
            },
            sleep: async () => {},
          }),
      }
    );
    expect(res.status).toBe(200);
  }
  return { plan: messPlan, demoPublic, fundRareAssets, posted };
}

const NODE_DATA = "data:";
const NODE_OFFER = "offer:";

function planNodes(plan: MessStepDef[], stepId: MessStepId, prefix: string): string[] {
  const nodes = plan.find((s) => s.id === stepId)?.nodeIds ?? [];
  for (const node of nodes) expect(node.startsWith(prefix)).toBe(true);
  return nodes.map((node) => node.slice(prefix.length));
}

const label = (asset: Asset): string => (asset.isNative() ? "native" : asset.getCode());

function assertPlanMatchesChain({ plan, demoPublic, fundRareAssets, posted }: RunResult): void {
  // Every plan step posted exactly one transaction, in plan order.
  expect(posted.map((p) => p.stepId)).toEqual(plan.map((s) => s.id));

  const trusted = new Set<string>(["native"]);
  const dataNames: string[] = [];
  const demoOffers: string[][] = [];
  const rarePayments: string[] = [];

  for (const { stepId, tx } of posted) {
    for (const op of tx.operations) {
      const source = op.source ?? tx.source;
      switch (op.type) {
        case "changeTrust":
          if (source === demoPublic) trusted.add(label(op.line as Asset));
          break;
        case "manageData":
          expect(source).toBe(demoPublic);
          dataNames.push(op.name);
          break;
        case "manageSellOffer":
          if (source !== demoPublic) break; // a swap counterparty's offer, not one the demo keeps
          for (const asset of [op.selling, op.buying]) {
            expect(trusted.has(label(asset))).toBe(true);
          }
          demoOffers.push([label(op.selling), label(op.buying)]);
          break;
        case "payment":
          if (op.destination !== demoPublic) break;
          expect(trusted.has(label(op.asset))).toBe(true);
          if (stepId === "FUND_RARE") rarePayments.push(label(op.asset));
          break;
        case "pathPaymentStrictReceive":
          if (op.destination === demoPublic) expect(trusted.has(label(op.destAsset))).toBe(true);
          break;
      }
    }
  }

  expect(dataNames).toEqual(planNodes(plan, "DATA_ENTRIES", NODE_DATA));
  expect(demoOffers.map((_, i) => String(i))).toEqual(planNodes(plan, "OFFERS", NODE_OFFER));
  expect(plan.some((s) => s.id === "FUND_RARE")).toBe(fundRareAssets.length > 0);
  expect(rarePayments).toEqual(fundRareAssets);
}

describe("the plan declares what the executor posts", () => {
  for (const mode of ["light", "standard", "full"] as const) {
    test(`${mode} mode`, async () => {
      const run = await runRecipe(mode);
      assertPlanMatchesChain(run);
      // Light posts no offers or data entries; the others post a non-empty set of each.
      const posts = run.posted.flatMap((p) => p.tx.operations.map((op) => op.type));
      expect(posts.includes("manageData")).toBe(mode !== "light");
    });
  }

  test("every custom configuration", async () => {
    let cases = 0;
    for (let trustlineCount = 1; trustlineCount <= 5; trustlineCount++) {
      for (let offerCount = 0; offerCount <= maxOfferCount(trustlineCount); offerCount++) {
        for (let dataEntryCount = 0; dataEntryCount <= 5; dataEntryCount++) {
          for (const addSigner of [false, true]) {
            assertPlanMatchesChain(
              await runRecipe("custom", { trustlineCount, offerCount, dataEntryCount, addSigner })
            );
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(240);
  }, 60_000);
});
