"use client";

import { useEffect, useState, type ReactElement } from "react";
import { AlertTriangle, CheckCircle } from "lucide-react";
import type { CosignStatus } from "@/hooks/useCloseExecution";
import { readCosignFile } from "@/lib/cosign/artifact";
import { COSIGN_UNAVAILABLE } from "@/lib/cosign/merge";
import { fingerprintOf, IMPORT_FLOOR_SECONDS } from "@/lib/cosign/station-checks";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";

interface Props {
  status: CosignStatus;
  requiredWeight: number;
  /** Adds a response's signatures; resolves to why it was refused, or null. */
  onImport: (text: string) => string | null;
  onContinue: () => void;
  onRebuild: () => void;
  /** Rebuilding signs the new step again here, so it needs a signer. */
  canRebuild: boolean;
  disabled: boolean;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function saveRequest(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "lumenwipe-cosign-request.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * "Sign on another device" on the paused round (docs/multisig-cosigning.md Section 4): the request
 * to send, the fingerprint to read out, and the responses to bring back. The fingerprint is shown
 * here only, never in the request.
 */
export default function CosignExchange({
  status,
  requiredWeight,
  onImport,
  onContinue,
  onRebuild,
  canRebuild,
  disabled,
}: Props): ReactElement | null {
  const [now, setNow] = useState(nowSeconds);
  const [responseText, setResponseText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    const timer = setInterval(() => setNow(nowSeconds()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const exported = status.export;
  if (!exported.available && exported.reason === COSIGN_UNAVAILABLE.notNormalization) return null;

  const secondsLeft = exported.available ? exported.maxTime - now : 0;
  const exportable = exported.available && secondsLeft >= IMPORT_FLOOR_SECONDS;
  const fingerprint = exported.available ? fingerprintOf(exported.hash) : "";

  const importResponse = (text: string): void => {
    const refusal = onImport(text);
    setImportError(refusal);
    if (refusal === null) setResponseText("");
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      importResponse(await readCosignFile(file));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "This file could not be read.");
    }
  };

  const copyRequest = async (request: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(request);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="cosign-exchange">
      <h3 className="text-base font-semibold text-fg">Sign on another device</h3>
      {exported.available && exportable ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-fg-subtle">Characters to read out</dt>
            <dd data-testid="cosign-fingerprint" className="font-mono text-fg">
              {fingerprint.slice(0, 8)} {fingerprint.slice(8)}
            </dd>
            <dt className="text-fg-subtle">Time left</dt>
            <dd className="text-fg">{secondsLeft} seconds</dd>
          </dl>
          <p className="text-sm text-fg-muted">
            Send the request to the cosigner, then read them the characters above by voice or
            another channel. Tell them: open{" "}
            <span className="font-mono-address break-all text-fg">{origin}/cosign</span> yourself,
            in a browser, by typing it. Do not open a link you were sent. Type this account address,
            then import the request. Before you sign, type the 16 characters I read to you. This
            request expires in {secondsLeft} seconds.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => saveRequest(exported.request)}>
              Save request file
            </Button>
            <Button variant="secondary" onClick={() => void copyRequest(exported.request)}>
              Copy request
            </Button>
          </div>
          {copied !== null && (
            <p role="status" className="text-sm text-fg-muted">
              {copied ? "Request copied." : "Could not copy. Save the file instead."}
            </p>
          )}
          <Field label="Response file">
            <Input
              type="file"
              accept="application/json,.json"
              disabled={disabled}
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
          </Field>
          <Field label="Or paste a response">
            <Textarea
              rows={3}
              value={responseText}
              spellCheck={false}
              disabled={disabled}
              onChange={(e) => setResponseText(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>
          <Button
            variant="secondary"
            disabled={disabled || responseText.trim() === ""}
            onClick={() => importResponse(responseText)}
          >
            Add response
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-fg-muted">
            {exported.available
              ? "This request is about to expire, so another device would refuse it."
              : exported.reason}
          </p>
          <Button variant="secondary" disabled={disabled || !canRebuild} onClick={onRebuild}>
            Rebuild and re-export
          </Button>
          {!canRebuild && (
            <p className="text-xs text-fg-subtle">Connect the master key to rebuild this step.</p>
          )}
        </>
      )}
      {importError && (
        <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
          {importError}
        </Callout>
      )}
      <p role="status" className="text-sm text-fg">
        {status.collectedWeight} of {requiredWeight} signing weight collected.
      </p>
      {status.ready && (
        <Callout tone="success" icon={<CheckCircle className="h-4 w-4" />}>
          <div className="flex flex-col gap-3">
            <span>Enough signatures are collected to continue.</span>
            <Button disabled={disabled} onClick={onContinue}>
              Continue the close
            </Button>
          </div>
        </Callout>
      )}
    </Card>
  );
}
