import { expect, test } from "bun:test";
import { Address, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { SoroswapSDK, SupportedNetworks } from "@soroswap/sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { resolveWasmHash, soroswapConversionContracts } from "@/lib/contract-registry";
import { assertConversionShape } from "@/lib/close-api/token-conversion-round";
import {
  buildTokenConversion,
  quoteTokenToXlm,
  xlmContractId,
} from "@/lib/soroswap/conversion-quotes";
import { readLiveWasmHash } from "@/lib/stellar/contract-instance";
import { getRpcServer } from "@/lib/stellar/rpc";

// Live, read-only QA of the conversion path against the real Soroswap API and mainnet RPC: a quote
// for a routable token, the swap the API builds for a real holder of it, and our shape assertion
// over those exact bytes. Nothing is signed or submitted; the holder is a third party whose
// balance is only read. Opt-in like every integration test, and it needs SOROSWAP_API_KEY.
//
// USDC stands in for a Soroban-native token here: the aggregator prices any contract, and the two
// Soroban-native tokens on the mainnet list have no route today, so this exercises the same swap
// shapes (router with a path, aggregator with a distribution) a native token would produce. The
// quote asks the Soroban AMMs only, as the module does: the order book is a classic path payment.
const RUN = !!process.env.LUMENWIPE_RUN_INTEGRATION && !!process.env.SOROSWAP_API_KEY;

const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
// A large USDC holder, from stellar.expert's holder list; only its sequence and balance are read.
const HOLDER = "GC5LF63GRVIT5ZXXCXLPI3RX2YXKJQFZVBSAO6AUELN3YIMSWPD6Z6FH";
const AMOUNT = 100_000_000n; // 10 USDC

test.skipIf(!RUN)(
  "mainnet: the Soroswap API's own swap for a real holder passes the conversion shape, and the contract it calls runs the registry's code",
  async () => {
    const sdk = new SoroswapSDK({
      apiKey: process.env.SOROSWAP_API_KEY!,
      baseUrl: process.env.SOROSWAP_API_URL,
      timeout: 20_000,
      defaultNetwork: SupportedNetworks.MAINNET,
    });
    const deps = { sdk, now: () => Date.now() };
    const quote = await quoteTokenToXlm(USDC, AMOUNT, "mainnet", deps);
    expect(quote, "no route for USDC -> XLM on mainnet").not.toBeNull();
    expect(BigInt(quote!.minAmountOut)).toBeLessThan(BigInt(quote!.amountOut));

    const xdr = await buildTokenConversion(quote!, HOLDER, "mainnet", deps);
    expect(xdr).not.toBeNull();
    const tx = TransactionBuilder.fromXDR(xdr!, NETWORK_PASSPHRASES.mainnet) as Transaction;

    const rpc = getRpcServer("mainnet");
    const live = await rpc.getAccount(HOLDER);
    const allowed = soroswapConversionContracts("mainnet");
    expect(allowed.aggregator.length + allowed.routers.length).toBeGreaterThan(0);
    expect(() =>
      assertConversionShape(tx, {
        token: USDC,
        account: HOLDER,
        xlm: xlmContractId("mainnet"),
        amountIn: AMOUNT,
        minOut: BigInt(quote!.minAmountOut),
        allowed,
        sequence: live.sequenceNumber(),
        nowSeconds: Math.floor(Date.now() / 1000),
      })
    ).not.toThrow();

    const called = Address.fromScAddress(
      tx
        .toEnvelope()
        .v1()
        .tx()
        .operations()[0]!
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .invokeContract()
        .contractAddress()
    ).toString();
    const hash = await readLiveWasmHash(rpc, called);
    const resolved = resolveWasmHash("mainnet", hash ?? "");
    expect(resolved.status).toBe("known");
    if (resolved.status === "known") {
      expect(resolved.protocol).toBe("soroswap");
      expect(["aggregator", "router"]).toContain(resolved.kind);
    }
  },
  90_000
);
