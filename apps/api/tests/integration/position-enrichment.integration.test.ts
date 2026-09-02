import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { BlendSupplyPosition } from "@lumenwipe/types";
import { servedContractRegistry } from "@/lib/contract-registry";
import { enrichDefiPositions, knownTokensFor, positionKey } from "@/lib/defi-positions/enrich";
import { blendPositionEnricher } from "@/lib/defi-positions/enrich/blend";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";

// Live testnet, opt-in like the other integration tests (`bun run test:integration`). Proves the
// real Blend SDK path end to end: pool name from the pool's own metadata, the reserve's current
// rates, the XLM symbol from the account read, and a zero underlying amount for an account that
// holds nothing there - all without a transaction.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

test.skipIf(!RUN_INTEGRATION)(
  "the registry's Blend testnet pool enriches a supply position through the real SDK",
  async () => {
    const pool = servedContractRegistry().entries.find(
      (e) => e.network === "testnet" && e.protocol === "blend" && e.kind === "pool"
    );
    expect(pool).toBeDefined();
    const account = Keypair.random().publicKey();
    const position: BlendSupplyPosition = {
      protocol: "blend",
      positionType: "supply",
      contractAddress: pool!.address,
      assetAddress: XLM_SAC,
      bTokenAmount: "0",
      usdValue: null,
    };
    const displays = await blendPositionEnricher()([position], {
      network: "testnet",
      account,
      knownTokens: knownTokensFor([], "testnet"),
    });
    const display = displays.get(positionKey(position));
    expect(display).toBeDefined();
    expect(display!.pool).toBeTruthy();
    expect(display!.asset).toBe("XLM");
    expect(display!.amount).toBe("0");
    expect(display!.collateralAmount).toBe("0");
    expect(display!.yieldKind).toBe("earned");
    expect(display!.yieldPct).toMatch(/^\d+\.\d{2}$/);

    // Through the orchestrator, the same position comes back with its display attached and the
    // XLM symbol in the enrichment map even though the direct read never fills it.
    const enriched = await enrichDefiPositions(
      {
        ...emptyDefiPositionsResult(account),
        positions: [position],
        source: "testnet-direct-read",
      },
      { network: "testnet", account, knownTokens: knownTokensFor([], "testnet") }
    );
    expect(enriched.positions[0]!.display?.pool).toBe(display!.pool);
    expect(enriched.enrichment[XLM_SAC]?.symbol).toBe("XLM");
  },
  30_000
);
