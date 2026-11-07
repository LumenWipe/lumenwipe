import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  CloseDeliveredResponseDto,
  CloseStatusResponseDto,
  TransactionLookupResponseDto,
} from "./dto/close-responses.dto";
import { ApiErrorResponse } from "@/common/api-error-response.decorator";
import { fail } from "@/common/fail";
import { NetworkPipe } from "@/common/pipes/network.pipe";
import { RPC_SERVER_FACTORY, type RpcServerFactory } from "@/common/ports";
import type { Network } from "@/config/networks";
import { readCloseStatus, type LastOperationReader } from "@/lib/close-api/close-status";
import {
  DELIVERED_MAX_HASHES,
  readDelivered,
  type HorizonTransactionReader,
  type HorizonTransactionRecord,
} from "@/lib/close-api/delivered-amount";
import { lookupTransaction } from "@/lib/close-api/transaction-lookup";
import { horizonDepsFor } from "@/lib/stellar/account-state";
import { horizonGet } from "@/lib/stellar/horizon-http";
import { horizonFallbacksFor, withHorizonFailover } from "@/lib/stellar/provider-failover";
import { isValidGAddress } from "@/lib/utils/validation";

const TX_HASH = /^[0-9a-f]{64}$/i;

function lastOperationReader(network: Network): LastOperationReader {
  return (source) =>
    withHorizonFailover(
      network,
      horizonDepsFor(network),
      horizonFallbacksFor(network),
      async (attempt) => {
        const page = await horizonGet<{ _embedded?: { records?: { type: string }[] } }>(
          `/accounts/${source}/operations?order=desc&limit=1`,
          attempt
        );
        return page?._embedded?.records?.[0] ?? null;
      }
    );
}

function horizonTransactionReader(network: Network): HorizonTransactionReader {
  return (hash) =>
    withHorizonFailover(network, horizonDepsFor(network), horizonFallbacksFor(network), (attempt) =>
      horizonGet<HorizonTransactionRecord>(`/transactions/${hash}`, attempt)
    );
}

/** Lowercase, distinct, valid hashes from the `hashes` query, or null when it cannot be used. */
function parseHashes(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  const hashes = raw.split(",").map((hash) => hash.toLowerCase());
  if (hashes.length > DELIVERED_MAX_HASHES) return null;
  if (!hashes.every((hash) => TX_HASH.test(hash))) return null;
  return new Set(hashes).size === hashes.length ? hashes : null;
}

@ApiTags("close")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiErrorResponse(401, "Missing or invalid API key.", ["unauthorized"])
@ApiErrorResponse(429, "Rate limit exceeded for this key.", ["rate_limited"])
@Controller("v1/:network")
export class TransactionsController {
  constructor(@Inject(RPC_SERVER_FACTORY) private readonly serverFor: RpcServerFactory) {}

  @ApiErrorResponse(400, "Invalid network or transaction hash.", [
    "invalid_network",
    "invalid_tx_hash",
  ])
  @ApiErrorResponse(503, "The network could not be read. Retry.", ["service_unavailable"])
  @Get("transactions/:hash")
  @ApiOperation({
    summary: "Look a transaction up by hash, without submitting anything.",
    description:
      "`not_found` means this RPC provider has no record of the hash in the ledger window named " +
      "by `searched`. It does not mean the transaction did not land or will not land: it may " +
      "still be queued, or be older than the window. Only a transaction whose time bounds ended " +
      "before `searched.latestLedgerCloseTime` can no longer land.",
  })
  @ApiResponse({
    status: 200,
    description: "The outcome: confirmed, failed or not_found.",
    type: TransactionLookupResponseDto,
  })
  async transaction(
    @Param("network", new NetworkPipe()) network: Network,
    @Param("hash") hash: string
  ) {
    if (!TX_HASH.test(hash)) {
      fail("invalid_tx_hash", "The transaction hash must be 64 hex characters.", 400);
    }
    try {
      return await lookupTransaction(this.serverFor(network), hash.toLowerCase());
    } catch {
      fail("service_unavailable", "The network could not be read. Retry.", 503);
    }
  }

  @ApiErrorResponse(400, "Invalid network or source account.", [
    "invalid_network",
    "invalid_source",
  ])
  @ApiErrorResponse(503, "The account could not be read. Retry.", ["service_unavailable"])
  @Get("close/status")
  @ApiOperation({
    summary: "Read how far an account is from closed, from live state.",
    description:
      "Stateless: nothing about a close is kept between calls. `remaining` covers what the ledger " +
      "counts on the account, not claimable balances or DeFi positions. `closed` is informational " +
      "and never proves that a particular close finished: confirm that by the transaction's hash.",
  })
  @ApiQuery({ name: "source", description: "The account being closed." })
  @ApiResponse({
    status: 200,
    description: "The phase, and the remaining work for an account still on the ledger.",
    type: CloseStatusResponseDto,
  })
  async status(
    @Param("network", new NetworkPipe()) network: Network,
    @Query("source") source: unknown
  ) {
    if (typeof source !== "string" || !isValidGAddress(source)) {
      fail("invalid_source", "source must be a valid Stellar account address.", 400);
    }
    try {
      return await readCloseStatus(this.serverFor(network), lastOperationReader(network), source);
    } catch {
      fail("service_unavailable", "The account could not be read. Retry.", 503);
    }
  }

  @ApiErrorResponse(400, "Invalid network, destination or transaction hashes.", [
    "invalid_network",
    "invalid_destination",
    "invalid_tx_hash",
  ])
  @ApiErrorResponse(503, "The network could not be read. Retry.", ["service_unavailable"])
  @Get("close/delivered")
  @ApiOperation({
    summary: "Read the XLM confirmed close transactions delivered to their destination.",
    description:
      "Read from the ledger's own result for each transaction, through RPC and then Horizon when " +
      "RPC no longer holds it. Counted: the balance a successful merge into `destination` " +
      "carried, as the merge's result reports it, and, for a close routed through the relay " +
      "account, the successful native payment to `destination` from the account a merge earlier " +
      "in the same transaction went into, at most once per merge and never more than that merge " +
      "carried. Not counted: XLM that reached `destination` by any other operation (a path " +
      "payment, or a payment without that merge) and any asset other than XLM. An entry that " +
      "cannot be read as delivered is `unavailable` with a reason and no amount, and " +
      "`totalStroops` is present only when every entry is `delivered`. `not_found` means no " +
      "provider holds the hash: it may be unknown, still pending, or older than the providers " +
      "keep. Wait for `transactions/{hash}` to report `confirmed` before asking. A fee-bump " +
      "answers for its outer or its inner hash.",
  })
  @ApiQuery({ name: "destination", description: "The account the close sent its XLM to (G...)." })
  @ApiQuery({
    name: "hashes",
    description: `Comma-separated transaction hashes, 64 hex characters each, 1 to ${DELIVERED_MAX_HASHES} and distinct.`,
  })
  @ApiResponse({
    status: 200,
    description: "One entry per hash, in the order asked, and the total when every one resolved.",
    type: CloseDeliveredResponseDto,
  })
  async delivered(
    @Param("network", new NetworkPipe()) network: Network,
    @Query("destination") destination: unknown,
    @Query("hashes") rawHashes: unknown
  ) {
    if (typeof destination !== "string" || !isValidGAddress(destination)) {
      fail("invalid_destination", "destination must be a valid Stellar account address.", 400);
    }
    const hashes = parseHashes(rawHashes);
    if (!hashes) {
      fail(
        "invalid_tx_hash",
        `hashes must be 1 to ${DELIVERED_MAX_HASHES} distinct transaction hashes, comma-separated, each 64 hex characters.`,
        400
      );
    }
    try {
      return await readDelivered(
        this.serverFor(network),
        horizonTransactionReader(network),
        network,
        destination,
        hashes
      );
    } catch {
      fail("service_unavailable", "The network could not be read. Retry.", 503);
    }
  }
}
