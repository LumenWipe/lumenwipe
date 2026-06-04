import { NextRequest, NextResponse } from "next/server";
import { Transaction } from "@stellar/stellar-sdk";
import { isValidNetwork, NETWORK_PASSPHRASES, getMediatorPublicKey } from "@/config/networks";
import { getMediatorKeypair } from "@/lib/stellar/mediator-server";

/**
 * Co-signs the shared-mediator forward payment.
 *
 * The client builds and signs ONE atomic transaction:
 *   op0: accountMerge  source(user)     -> mediator
 *   op1: payment       source(mediator) -> exchange destination (+ memo)
 *
 * This endpoint validates that exact shape and, only then, adds the mediator's
 * signature. It can never change the destination or amount (that would break
 * the user's signature), so it cannot divert funds — it only co-signs the
 * payment leg of a transaction the user already authorized.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;
  if (!isValidNetwork(network)) {
    return NextResponse.json({ error: "Invalid network" }, { status: 400 });
  }

  const mediatorKeypair = getMediatorKeypair(network);
  if (!mediatorKeypair) {
    return NextResponse.json(
      { error: "Exchange (mediator) flow is not configured on this server." },
      { status: 503 }
    );
  }
  const mediator = mediatorKeypair.publicKey();

  // The configured public key must match the secret, or the build is misconfigured.
  const configuredPublic = getMediatorPublicKey(network);
  if (configuredPublic && configuredPublic !== mediator) {
    return NextResponse.json({ error: "Mediator key misconfiguration" }, { status: 500 });
  }

  let body: { transaction?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.transaction) {
    return NextResponse.json({ error: "Missing transaction" }, { status: 400 });
  }

  let tx: Transaction;
  try {
    tx = new Transaction(body.transaction, NETWORK_PASSPHRASES[network]);
  } catch {
    return NextResponse.json({ error: "Invalid transaction XDR" }, { status: 400 });
  }

  const [merge, transfer] = tx.operations;

  // Shape: exactly [accountMerge, payment]. Narrow the op types first.
  if (
    tx.operations.length !== 2 ||
    merge?.type !== "accountMerge" ||
    transfer?.type !== "payment"
  ) {
    return NextResponse.json({ error: "Transaction structure not allowed" }, { status: 400 });
  }

  if (
    merge.source === mediator || // op0 must be merged BY the user, not the mediator
    merge.destination !== mediator || // ...INTO the mediator
    transfer.source !== mediator || // op1 must be paid FROM the mediator
    transfer.destination === mediator || // ...to someone else
    !transfer.asset.isNative() || // forwarding native XLM only
    parseFloat(transfer.amount) < 1 // safety floor
  ) {
    return NextResponse.json({ error: "Transaction structure not allowed" }, { status: 400 });
  }

  tx.sign(mediatorKeypair);
  return NextResponse.json({ transaction: tx.toEnvelope().toXDR("base64") });
}
