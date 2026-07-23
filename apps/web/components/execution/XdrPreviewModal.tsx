"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import type { Network } from "@/config/networks";

interface XdrPreviewModalProps {
  xdr: string;
  network: Network;
}

const LAB_NET_CONFIG: Record<
  Network,
  { id: string; label: string; horizonUrl: string; rpcUrl: string; passphrase: string }
> = {
  testnet: {
    id: "testnet",
    label: "Testnet",
    horizonUrl: "https:////horizon-testnet.stellar.org",
    rpcUrl: "https:////soroban-testnet.stellar.org",
    passphrase: "Test%20SDF%20Network%20/;%20September%202015",
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    horizonUrl: "https:////horizon.stellar.org",
    rpcUrl: "https:////soroban.stellar.org",
    passphrase: "Public%20Global%20Stellar%20Network%20/;%20September%202015",
  },
};

function buildLabXdrUrl(xdr: string, network: Network): string {
  const cfg = LAB_NET_CONFIG[network];
  const escapedXdr = xdr.replace(/\//g, "//");
  return (
    `https://lab.stellar.org/xdr/view?$=network$id=${cfg.id}&label=${cfg.label}` +
    `&horizonUrl=${cfg.horizonUrl}&rpcUrl=${cfg.rpcUrl}&passphrase=${cfg.passphrase};` +
    `&xdr$blob=${escapedXdr};;`
  );
}

export default function XdrPreviewModal({ xdr, network }: XdrPreviewModalProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(xdr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 mkt-mono text-xs text-white/55 hover:text-white hover:bg-white/[0.04] transition-colors"
      >
        <span className="flex items-center gap-1.5">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          View raw transaction (XDR)
        </span>
      </button>

      {open && (
        <div className="border-t border-white/10 bg-black/30 p-3">
          <div className="flex items-start justify-between gap-2 mb-2">
            <p className="text-xs text-white/50">
              Base64-encoded XDR envelope. You can inspect this in{" "}
              <a
                href={buildLabXdrUrl(xdr, network)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-stellar hover:underline"
              >
                Stellar Lab
              </a>
              .
            </p>
            <button
              onClick={handleCopy}
              className="shrink-0 flex items-center gap-1 text-xs text-white/55 hover:text-white transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 text-emerald-500" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" /> Copy
                </>
              )}
            </button>
          </div>
          <pre className="text-xs mkt-mono text-white/60 break-all whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
            {xdr}
          </pre>
        </div>
      )}
    </div>
  );
}
