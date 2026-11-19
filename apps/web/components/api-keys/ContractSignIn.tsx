"use client";

import { useState, type FormEvent, type ReactElement } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input, Textarea } from "@/components/ui/field";
import type { Network } from "@/config/networks";
import {
  IntegratorRequestError,
  requestContractChallenge,
  type ContractChallenge,
} from "@/lib/integrator/client";
import { accountEntryXdr, withSignedEntry } from "@/lib/integrator/contract-sign-in";
import { WalletSignInError } from "@/lib/integrator/wallet-sign-in";

export const CONTRACT_SIGN_IN_ERRORS = {
  address: "Enter a contract account address. It starts with C.",
  unavailable:
    "Contract-account sign-in is not available on this network yet. Sign in with a regular account (its address starts with G) instead.",
  mismatch:
    "That is not this challenge's entry signed for this account. Paste the signed entry, or the whole signed list.",
  other: "Something went wrong. Please try again.",
} as const;

export interface ContractSignInProps {
  disabled: boolean;
  /** Fills the account in, after a wallet or Pollar could not sign for it. */
  initial?: { address: string; network: Network } | null;
  onSignIn: (network: Network, address: string, authorizationEntries: string) => Promise<void>;
}

function messageOf(e: unknown): string {
  if (e instanceof WalletSignInError) return CONTRACT_SIGN_IN_ERRORS.mismatch;
  if (e instanceof IntegratorRequestError) {
    return e.code === "contract_sign_in_unavailable"
      ? CONTRACT_SIGN_IN_ERRORS.unavailable
      : e.message;
  }
  return CONTRACT_SIGN_IN_ERRORS.other;
}

/**
 * Contract-account sign-in by hand: the page fetches the challenge, the visitor signs the
 * account's entry with whatever controls the account, and pastes it back. Nothing here signs.
 */
export default function ContractSignIn({
  disabled,
  initial,
  onSignIn,
}: ContractSignInProps): ReactElement {
  const [address, setAddress] = useState(initial?.address ?? "");
  const [network, setNetwork] = useState<Network>(initial?.network ?? "mainnet");
  const [challenge, setChallenge] = useState<ContractChallenge | null>(null);
  const [signed, setSigned] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const account = address.trim();

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const getChallenge = (event: FormEvent) => {
    event.preventDefault();
    if (!StrKey.isValidContract(account)) {
      setError(CONTRACT_SIGN_IN_ERRORS.address);
      return;
    }
    void run(async () => {
      setChallenge(await requestContractChallenge(network, account));
      setSigned("");
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    void run(() => onSignIn(network, account, withSignedEntry(challenge, account, signed)));
  };

  if (challenge) {
    return (
      <form noValidate className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-white/65">
          Sign this authorization entry for {account} with what controls the account, on {network},
          valid until ledger {challenge.validUntilLedger} at the latest. It authorizes only the
          sign-in check: it moves no funds and costs no fee.
        </p>
        <div className="flex items-start gap-2">
          <code className="mkt-mono block max-h-32 min-w-0 flex-1 overflow-y-auto break-all rounded-control bg-black/30 p-3 text-xs text-white/90">
            {accountEntryXdr(challenge, account)}
          </code>
          <CopyButton value={accountEntryXdr(challenge, account)} label="authorization entry" />
        </div>
        <Field
          label="Signed entry"
          helper="Paste the signed entry, or the whole signed list, as base64 XDR."
          error={error ?? undefined}
        >
          <Textarea
            rows={4}
            spellCheck={false}
            value={signed}
            onChange={(event) => setSigned(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant="secondary"
            loading={busy}
            disabled={disabled || busy || !signed.trim()}
          >
            {busy ? "Checking the signature..." : "Sign in"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => {
              setChallenge(null);
              setError(null);
            }}
          >
            Start over
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form noValidate className="space-y-3" onSubmit={getChallenge}>
      <Field
        label="Contract account"
        helper="The C... address of your smart wallet."
        error={error ?? undefined}
      >
        <Input
          spellCheck={false}
          autoComplete="off"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg">Network</legend>
        <div className="flex flex-wrap gap-4">
          {(["mainnet", "testnet"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm text-white/80">
              <input
                type="radio"
                name="contract-sign-in-network"
                value={value}
                checked={network === value}
                onChange={() => setNetwork(value)}
              />
              {value === "mainnet" ? "Mainnet" : "Testnet"}
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" variant="secondary" loading={busy} disabled={disabled || busy}>
        {busy ? "Getting the challenge..." : "Get the sign-in challenge"}
      </Button>
    </form>
  );
}
