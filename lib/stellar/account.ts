import { Keypair, xdr, StrKey, Asset, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { getRpcServer, getTrustlineEntry } from "./rpc";
import { fetchOffersFromAdapter } from "./horizon-adapter";
import { seGet } from "@/lib/se-api/client";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import type { Network } from "@/config/networks";
import type {
  AccountState,
  AccountSigner,
  AccountThresholds,
  DataEntry,
  Trustline,
  OpenOffer,
  PoolShareEntry,
} from "@/types/account";

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

  // 2. Read full AccountEntry XDR for signers, thresholds, balances, and sponsoring counters
  let signers: AccountSigner[] = [{ key: address, weight: 1, type: "ed25519_public_key" }];
  let thresholds: AccountThresholds = { low: 0, med: 1, high: 1 };
  let numSubEntries = 0;
  let numSponsoring = 0;
  let nativeBalanceLumens = "0";

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

  // 6. Re-read each trustline's live state over RPC; the indexer list is only a hint
  const trustlines: Trustline[] = [];
  const nonNativeAssets = seAssets
    .map(parseSeAsset)
    .filter((a): a is { code: string; issuer: string } => a !== null);

  for (const { code, issuer } of nonNativeAssets) {
    try {
      const asset = new Asset(code, issuer);
      const tl = await getTrustlineEntry(server, address, asset);
      if (!tl) continue; // removed on-chain since the indexer saw it

      const balStroops = BigInt(tl.balance().toString());
      const limitStroops = BigInt(tl.limit().toString());
      const balance = stroopsToXlm(balStroops);
      const limit = stroopsToXlm(limitStroops);
      const authorized = (tl.flags() & 1) === 1;

      trustlines.push({ asset: `${code}:${issuer}`, balance, limit, authorized, issuer, code });
    } catch (err) {
      if (process.env.NODE_ENV !== "production")
        console.warn(`[account] trustline fetch failed for ${code}:${issuer}:`, err);
    }
  }

  // 7. numSubEntries reconciliation - only when offers were fetched from the Horizon adapter
  // (if the URL is not configured, openOffers=[] and the count would be misleadingly low).
  let subEntryMismatch = false;
  if (PATH_ROUTING_API_URLS[network]) {
    const extraSigners = signers.filter((s) => s.key !== address).length;
    const expectedSubEntries =
      trustlines.length +
      openOffers.length +
      dataEntries.length +
      extraSigners +
      poolShares.length * 2; // pool shares cost 2 base reserves per ledger spec
    subEntryMismatch = expectedSubEntries < numSubEntries;
  }

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
    trustlines,
    openOffers,
    poolShares,
    subEntryMismatch,
  };
}
