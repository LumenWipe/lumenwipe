"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import {
  NETWORK_LABELS,
  NETWORK_PASSPHRASES,
  VALID_NETWORKS,
  type Network,
} from "@/config/networks";
import { useActiveSigner } from "@/hooks/useActiveSigner";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { readAccount } from "@/lib/api/analyze-client";
import { CosignArtifactError, parseCosignArtifact, readCosignFile } from "@/lib/cosign/artifact";
import {
  assertSigningTime,
  assertStationSigner,
  checkRequest,
  fingerprintMatches,
  responseFromSigned,
  type CheckedRequest,
  type LiveAccount,
} from "@/lib/cosign/station-checks";
import { SecretKeySigner } from "@/lib/stellar/signer";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { isValidGAddress } from "@/lib/utils/validation";
import { toUserMessage } from "@/lib/utils/user-error";
import { walletKitSigner } from "@/lib/wallet-kit/client";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
import { AddressField } from "@/components/ui/address-field";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Tabs, type TabItem } from "@/components/ui/tabs";

type SignMode = "wallet" | "secret-key";
const SIGN_MODES: readonly TabItem<SignMode>[] = [
  { value: "wallet", label: "Wallet" },
  { value: "secret-key", label: "Secret key" },
];

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function messageOf(err: unknown): string {
  return err instanceof CosignArtifactError ? err.message : toUserMessage(err, "wallet");
}

function saveResponse(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "lumenwipe-cosign-response.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * The cosign station (docs/multisig-cosigning.md Section 5): checks one signer normalization
 * request against the account the cosigner typed and the station's own live read, signs it with
 * one signer, and hands back that signer's signature. It submits nothing and keeps nothing: the
 * request, the response and the signer live in this component's state only.
 */
export default function CosignStation(): ReactElement {
  const [network, setNetwork] = useState<Network>("mainnet");
  const [account, setAccount] = useState("");
  const [live, setLive] = useState<LiveAccount | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [requestText, setRequestText] = useState("");
  const [checkedState, setChecked] = useState<CheckedRequest | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [typedFingerprint, setTypedFingerprint] = useState("");
  const [mode, setMode] = useState<SignMode>("wallet");
  const [keyAccepted, setKeyAccepted] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [now, setNow] = useState(nowSeconds);
  const secretKeyRef = useRef("");
  const { active, select, clear, clearKind, current } = useActiveSigner();
  const walletConnection = useWalletKitConnection(network, { recheckOnFocus: true });

  const accountValid = isValidGAddress(account);
  // A check that finished after the account or network changed belongs to neither.
  const checked =
    checkedState?.account === account && checkedState.network === network ? checkedState : null;

  const forgetRequest = useCallback((): void => {
    setRequestText("");
    setChecked(null);
    setImportError(null);
    setTypedFingerprint("");
    setSignError(null);
    setResponse(null);
    setCopied(null);
  }, []);

  useEffect(() => {
    setLive(null);
    setReadError(null);
    forgetRequest();
    clearKind("secret-key");
    setKeyAccepted(false);
    if (!accountValid) return;
    const controller = new AbortController();
    readAccount(network, account, controller.signal).then(
      (state) =>
        setLive({
          sequence: state.sequence,
          signers: state.signers,
          thresholds: state.thresholds,
          authImmutable: state.authImmutable,
        }),
      (err: unknown) => {
        if (!controller.signal.aborted) setReadError(toUserMessage(err, "analyze"));
      }
    );
    return () => controller.abort();
  }, [network, account, accountValid, forgetRequest, clearKind]);

  useEffect(() => {
    if (!checked) return;
    const timer = setInterval(() => setNow(nowSeconds()), 1_000);
    return () => clearInterval(timer);
  }, [checked]);

  useEffect(() => {
    if (mode !== "wallet") return;
    const address = walletConnection.address;
    if (walletConnection.verified && address) {
      select("wallet", walletKitSigner(network, address));
    } else if (current()?.kind === "wallet") {
      clear();
    }
  }, [mode, network, walletConnection.verified, walletConnection.address, select, clear, current]);

  useEffect(() => () => clear(), [clear]);

  const importRequest = (text: string): void => {
    setChecked(null);
    setTypedFingerprint("");
    setSignError(null);
    setResponse(null);
    if (!live) return;
    try {
      const artifact = parseCosignArtifact(text, "request");
      setChecked(checkRequest({ artifact, network, account, live, nowSeconds: nowSeconds() }));
      setNow(nowSeconds());
      setImportError(null);
    } catch (err) {
      setImportError(messageOf(err));
    }
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const text = await readCosignFile(file);
      setRequestText(text);
      importRequest(text);
    } catch (err) {
      setImportError(messageOf(err));
    }
  };

  const fingerprintOk = checked !== null && fingerprintMatches(typedFingerprint, checked.hash);
  const fingerprintError =
    checked && typedFingerprint.replace(/[\s.…]/g, "").length >= 16 && !fingerprintOk
      ? "The characters do not match. Do not sign. Check them with the initiator."
      : null;
  const secondsLeft = checked ? checked.maxTime - now : 0;

  const sign = async (): Promise<void> => {
    const held = current();
    if (!checked || !live || !held || !fingerprintMatches(typedFingerprint, checked.hash)) return;
    setSigning(true);
    setSignError(null);
    try {
      assertStationSigner(live, held.signer.publicKey);
      assertSigningTime(checked, nowSeconds());
      if (held.kind === "wallet") await walletConnection.beforeSigning(held.signer.publicKey)();
      const signedXdr = await held.signer.sign(checked.xdr, NETWORK_PASSPHRASES[checked.network]);
      setResponse(
        responseFromSigned({ request: checked, signedXdr, live, signerKey: held.signer.publicKey })
      );
      if (held.kind === "secret-key") clear();
    } catch (err) {
      setSignError(messageOf(err));
    } finally {
      setSigning(false);
    }
  };

  const done = (): void => {
    forgetRequest();
    clear();
    secretKeyRef.current = "";
    setKeyAccepted(false);
  };

  const copyResponse = async (): Promise<void> => {
    if (!response) return;
    try {
      await navigator.clipboard.writeText(response);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-2">
        <Link href="/" className="text-sm text-fg-muted hover:text-fg">
          LumenWipe
        </Link>
        <h1 className="text-2xl font-semibold text-fg">Cosign a transaction</h1>
        <p className="text-sm text-fg-muted">
          Sign one step of a close that someone else started, from this device. This page checks the
          request itself, signs it with your key, and gives you a response to send back. It sends
          nothing to the network and keeps nothing.
        </p>
      </div>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-base font-semibold text-fg">1. Account</h2>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm text-fg">Network</legend>
          <div className="flex flex-wrap gap-2 pt-1.5">
            {VALID_NETWORKS.map((option) => (
              <label
                key={option}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control border border-line-strong px-3 text-sm text-fg"
              >
                <input
                  type="radio"
                  name="cosign-network"
                  value={option}
                  checked={network === option}
                  onChange={() => setNetwork(option)}
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                {NETWORK_LABELS[option]}
              </label>
            ))}
          </div>
        </fieldset>
        <AddressField
          label="Account to cosign for"
          value={account}
          onChange={setAccount}
          helper="Type the account address yourself. The request must be for this account."
        />
        {accountValid && !live && !readError && (
          <p role="status" className="text-sm text-fg-muted">
            Reading the account…
          </p>
        )}
        {readError && (
          <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
            {readError}
          </Callout>
        )}
      </Card>

      {live && (
        <Card className="flex flex-col gap-4 p-4">
          <h2 className="text-base font-semibold text-fg">2. Request</h2>
          <Field label="Request file">
            <Input
              type="file"
              accept="application/json,.json"
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
          </Field>
          <Field label="Or paste the request" helper="Paste the text the initiator sent you.">
            <Textarea
              rows={4}
              value={requestText}
              spellCheck={false}
              onChange={(e) => setRequestText(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>
          <Button
            variant="secondary"
            disabled={requestText.trim() === ""}
            onClick={() => importRequest(requestText)}
          >
            Check request
          </Button>
          {importError && (
            <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
              {importError}
            </Callout>
          )}
        </Card>
      )}

      {live && checked && (
        <Card className="flex flex-col gap-4 p-4">
          <h2 className="text-base font-semibold text-fg">3. What you are signing</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-fg-subtle">Signers removed</dt>
            <dd className="text-fg">
              {checked.summary.removedSigners.length === 0 ? (
                "None"
              ) : (
                <ul>
                  {checked.summary.removedSigners.map((s) => (
                    <li key={s.key} className="font-mono-address break-all">
                      {s.key}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt className="text-fg-subtle">New thresholds</dt>
            <dd className="text-fg">
              Low {checked.summary.thresholds.low}, medium {checked.summary.thresholds.med}, high{" "}
              {checked.summary.thresholds.high}
            </dd>
            <dt className="text-fg-subtle">Network fee</dt>
            <dd className="text-fg">{stroopsToXlm(checked.summary.feeStroops)} XLM</dd>
            <dt className="text-fg-subtle">Time left</dt>
            <dd className="text-fg">
              {secondsLeft > 0 ? `${secondsLeft} seconds` : "This request has expired"}
            </dd>
          </dl>
          <Callout tone="warning" announce={false} icon={<ShieldAlert className="h-4 w-4" />}>
            Signing this gives the master key,{" "}
            <span className="font-mono-address break-all">{checked.summary.master}</span>, sole
            control of this account. After it, the master key holder alone decides where the funds
            go.
          </Callout>
          <Field
            label="Transaction hash characters"
            helper="Type the 16 characters the initiator reads to you."
            error={fingerprintError}
          >
            <Input
              value={typedFingerprint}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTypedFingerprint(e.target.value)}
              className="font-mono"
            />
          </Field>
        </Card>
      )}

      {live && checked && !response && (
        <Card className="flex flex-col gap-4 p-4">
          <h2 className="text-base font-semibold text-fg">4. Sign</h2>
          <Tabs
            label="How to sign"
            items={signing ? SIGN_MODES.map((m) => ({ ...m, disabled: true })) : SIGN_MODES}
            value={mode}
            onValueChange={(next) => {
              if (next !== mode) clear();
              setMode(next);
            }}
          >
            {mode === "wallet" ? (
              <WalletConnectPanel
                connection={walletConnection}
                disabled={signing}
                signingNetwork={network}
              />
            ) : !keyAccepted ? (
              <Callout
                tone="warning"
                announce={false}
                icon={<AlertTriangle className="h-4 w-4" />}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setKeyAccepted(true)}>
                    Use a secret key anyway
                  </Button>
                }
              >
                This page runs on a shared website. A wallet keeps your key out of the page; a
                secret key typed here is held by this page until you sign or leave. Use a wallet if
                you can.
              </Callout>
            ) : active.kind === "secret-key" ? (
              <p className="text-sm text-fg">
                Secret key loaded for{" "}
                <span className="font-mono-address break-all">{active.id}</span>
              </p>
            ) : (
              <SecretKeyInput
                secretKeyRef={secretKeyRef}
                onValidityChange={(valid) => {
                  if (!valid) return;
                  select("secret-key", new SecretKeySigner(secretKeyRef.current));
                  secretKeyRef.current = "";
                }}
              />
            )}
          </Tabs>
          <Button
            disabled={!fingerprintOk || active.kind === "none" || signing || secondsLeft <= 0}
            loading={signing}
            onClick={() => void sign()}
          >
            Sign this transaction
          </Button>
          {signError && (
            <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
              {signError}
            </Callout>
          )}
        </Card>
      )}

      {response && (
        <Card className="flex flex-col gap-4 p-4">
          <h2 className="text-base font-semibold text-fg">5. Send the response back</h2>
          <p className="text-sm text-fg-muted">
            Save or copy the response and send it to the initiator. It holds only your signature.
            Anyone who holds enough signatures can submit this transaction until it expires.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => saveResponse(response)}>Save response file</Button>
            <Button variant="secondary" onClick={() => void copyResponse()}>
              Copy response
            </Button>
          </div>
          {copied !== null && (
            <p role="status" className="text-sm text-fg-muted">
              {copied ? "Response copied." : "Could not copy. Save the file instead."}
            </p>
          )}
          <Button variant="ghost" onClick={done}>
            Done: forget this request
          </Button>
        </Card>
      )}
    </div>
  );
}
