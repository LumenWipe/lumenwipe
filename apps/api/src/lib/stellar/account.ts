import { Keypair, xdr, StrKey, Asset } from "@stellar/stellar-sdk";
import { getRpcServer } from "./rpc";
import { fetchOffersFromAdapter, fetchClaimableBalancesForClaimant } from "./horizon-adapter";
import { seGet } from "@/lib/se-api/client";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { detectSubEntryMismatch } from "@/lib/stellar/scan-fallback";
import type { Network } from "@/config/networks";
import type {
  AccountState,
  AccountSigner,
  AccountThresholds,
  ClaimableBalance,
  DataEntry,
  Trustline,
  OpenOffer,
  PoolShareEntry,
} from "@/types/account";

// AUTH_IMMUTABLE is bit 2 (value 4) of the account flags uint32 (CAP-0035 / Protocol 14).
// An account with this flag set permanently blocks ACCOUNT_MERGE.
const AUTH_IMMUTABLE_FLAG = 4;

// ─── XDR helpers ──────────────────────────────────────────────────────────────

function parseXdrSigner(s: xdr.Signer): AccountSigner | null {
  const weight = s.weight();
  const typeName = (s.key().switch() as { name: string }).name;

  switch (typeName) {
    case "signerKeyTypeEd25519":
      return {
        key: StrKey.encodeEd25519PublicKey(s.key().ed25519()),
        weight,
        type: "ed25519_public_key",
      };
    case "signerKeyTypePreAuthTx":
      return { key: StrKey.encodePreAuthTx(s.key().preAuthTx()), weight, type: "preauth_tx" };
    case "signerKeyTypeHashX":
      return { key: StrKey.encodeSha256Hash(s.key().hashX()), weight, type: "hash_x" };
    case "signerKeyTypeEd25519SignedPayload": {
      const sp = s.key().ed25519SignedPayload();
      return {
        key: StrKey.encodeSignedPayload(sp.toXDR()),
        weight,
        type: "ed25519_signed_payload",
      };
    }
    default:
      return null;
  }
}

// ─── SE API types ─────────────────────────────────────────────────────────────

interface SeAccountSummary {
  account?: string;
  assets?: string[];
  data?: Record<string, string>;
}

// Parse SE API asset string like "USDCAllow-GISSUER56CHARS-2" or "XLM" or "L{64hex}"
function parseSeAsset(raw: string): { code: string; issuer: string } | null {
  if (raw === "XLM") return null;
  if (/^L[0-9a-f]{64}$/i.test(raw)) return null; // pool share - handled separately
  const match = raw.match(/^(.+)-([GC][A-Z0-9]{55})-\d+$/);
  if (!match) return null;
  return { code: match[1], issuer: match[2] };
}

const POOL_SHARE_RE = /^L([0-9a-f]{64})$/i;

// ─── Main export ───────────────────────────────────────────────────────────────

export async function getAccountState(address: string, network: Network): Promise<AccountState> {
  const server = getRpcServer(network);

  // 1. Validate existence and get sequence number via Stellar RPC
  let sequence: string;
  try {
    const rpcAccount = await server.getAccount(address);
    sequence = rpcAccount.sequenceNumber();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("not found") || msg.includes("404")) {
      throw new AccountNotFoundError(address);
    }
    throw err;
  }

  // 2. Read full AccountEntry XDR for signers, thresholds, balances, flags, and sponsoring counters
  let signers: AccountSigner[] = [{ key: address, weight: 1, type: "ed25519_public_key" }];
  let thresholds: AccountThresholds = { low: 0, med: 1, high: 1 };
  let numSubEntries = 0;
  let numSponsoring = 0;
  let nativeBalanceLumens = "0";
  let authImmutable = false;

  try {
    const accountKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({
        accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
      })
    );
    const ledgerResp = await server.getLedgerEntries(accountKey);

    if (ledgerResp.entries && ledgerResp.entries.length > 0) {
      const entryData = ledgerResp.entries[0].val as xdr.LedgerEntryData;
      const accountEntry = entryData.account();

      const rawBalance = BigInt(accountEntry.balance().toString());
      nativeBalanceLumens = stroopsToXlm(rawBalance);

      const t = accountEntry.thresholds() as Buffer;
      thresholds = { low: t[1], med: t[2], high: t[3] };
      const masterWeight = t[0];

      authImmutable = (accountEntry.flags() & AUTH_IMMUTABLE_FLAG) !== 0;

      const rawSigners = accountEntry.signers();
      const parsedSigners: AccountSigner[] = [];
      for (const s of rawSigners) {
        const parsed = parseXdrSigner(s);
        if (parsed) {
          parsedSigners.push(parsed);
        } else if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[account] unknown signer key type, skipping:",
            (s.key().switch() as { name: string }).name
          );
        }
      }
      signers = [
        { key: address, weight: masterWeight, type: "ed25519_public_key" },
        ...parsedSigners,
      ];

      numSubEntries = Number(accountEntry.numSubEntries());

      // numSponsoring lives in the account extension (Protocol 14+).
      // Missing extension means 0 sponsorships (pre-Protocol 14 or simply none).
      try {
        const ext = accountEntry.ext();
        if (ext.switch() === 1) {
          const innerExt = ext.v1().ext();
          if (innerExt.switch() === 2) {
            numSponsoring = innerExt.v2().numSponsoring();
          }
        }
      } catch {
        // Extension not present - numSponsoring stays 0
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.warn("[account] LedgerEntry XDR parse failed, using defaults:", err);
  }

  // 3. Enumerate assets and data entries from stellar.expert
  let seAssets: string[] = [];
  let dataEntries: DataEntry[] = [];

  try {
    const seAccount = await seGet<SeAccountSummary>(network, `/account/${address}`);
    seAssets = seAccount.assets ?? [];
    dataEntries = Object.entries(seAccount.data ?? {}).map(([key, value]) => ({ key, value }));
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.warn("[account] SE API account fetch failed:", err);
  }

  // 4. Detect pool shares from SE API asset list (L{64-hex} prefix)
  const poolShares: PoolShareEntry[] = seAssets
    .filter((a) => POOL_SHARE_RE.test(a))
    .map((a) => ({ poolId: a.slice(1).toLowerCase() }));

  // 5. Fetch open DEX offers via Horizon-compatible adapter (SE API endpoint is 404)
  const openOffers: OpenOffer[] = await fetchOffersFromAdapter(address, network);

  // 6. Fetch per-trustline balances via server.getAssetBalance(). A skipped
  //    trustline (rejection or missing balanceEntry) undercounts the scan and
  //    is caught by the sub-entry reconciliation below.
  const trustlines: Trustline[] = [];
  const nonNativeAssets = seAssets
    .map(parseSeAsset)
    .filter((a): a is { code: string; issuer: string } => a !== null);

  for (const { code, issuer } of nonNativeAssets) {
    try {
      const asset = new Asset(code, issuer);
      const res = await server.getAssetBalance(address, asset);
      if (!res.balanceEntry) continue;

      const balance = stroopsToXlm(BigInt(res.balanceEntry.amount));
      const authorized = res.balanceEntry.authorized;

      trustlines.push({ asset: `${code}:${issuer}`, balance, authorized, issuer, code });
    } catch (err) {
      if (process.env.NODE_ENV !== "production")
        console.warn(`[account] trustline fetch failed for ${code}:${issuer}:`, err);
    }
  }

  // 7. Fetch claimable balances where this account is a claimant via Horizon adapter.
  //    These are separate ledger entries and do NOT affect numSubEntries, but the
  //    assets will be inaccessible after ACCOUNT_MERGE unless claimed first.
  const claimableBalances: ClaimableBalance[] = await fetchClaimableBalancesForClaimant(
    address,
    network
  );

  // 8. numSubEntries reconciliation. This must run even when the offers adapter
  //    URL is unconfigured (openOffers=[]): an undercounted scan has to surface as
  //    a blocker rather than produce a plan that silently skips entries.
  //
  //    sponsoredBy is not available on this path: getLedgerEntries returns
  //    LedgerEntryData (stripped of the outer LedgerEntry.ext that carries sponsoringID).
  const subEntryMismatch = detectSubEntryMismatch({
    address,
    signers,
    trustlines,
    openOffers,
    dataEntries,
    poolShares,
    numSubEntries,
  });

  return {
    address,
    network,
    sequence,
    nativeBalanceLumens,
    dataEntries,
    signers,
    thresholds,
    numSubEntries,
    numSponsoring,
    sponsoredBy: null,
    authImmutable,
    trustlines,
    openOffers,
    poolShares,
    claimableBalances,
    subEntryMismatch,
  };
}
