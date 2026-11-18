"use client";

import { useEffect, useState } from "react";
import {
  bundledRegistry,
  fetchServedRegistry,
  type RegistryEntry,
  type RegistrySnapshot,
} from "@/lib/exchange-registry";
import { isUsableAt } from "@/lib/exchange-registry/merge";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { REGISTRY } from "@/lib/i18n/messages/registry";
import {
  PROTOCOLS,
  PROTOCOLS_VERIFIED,
  protocolStatusUsable,
  STATUS_LABEL,
} from "@/lib/site/status";

const T = REGISTRY[SITE_LOCALE];

interface Props {
  load?: () => Promise<RegistrySnapshot | null>;
  clock?: () => Date;
}

interface ExchangeGroup {
  name: string;
  domain: string;
  entries: RegistryEntry[];
}

const MEMO_TYPE: Record<RegistryEntry["memoType"], string> = {
  text: "text",
  id: "ID",
  hash: "hash",
};

function groupByExchange(entries: readonly RegistryEntry[]): ExchangeGroup[] {
  const groups = new Map<string, ExchangeGroup>();
  for (const entry of entries) {
    const key = `${entry.name}|${entry.domain}`;
    const group = groups.get(key) ?? { name: entry.name, domain: entry.domain, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function memoRule(entry: RegistryEntry): string {
  return entry.requiresMemo ? T.memoRequired(MEMO_TYPE[entry.memoType]) : T.noMemo;
}

function route(entry: RegistryEntry): string {
  return entry.requiresMediator ? T.throughRelay : T.mergedDirectly;
}

function DateLine({ lastVerified, validUntil }: { lastVerified: string; validUntil: string }) {
  return (
    <p className="mkt-mono text-caption text-fg-subtle">
      {T.dates(
        <time dateTime={lastVerified}>{lastVerified}</time>,
        <time dateTime={validUntil}>{validUntil}</time>
      )}
    </p>
  );
}

function Verdict({ usable, expired }: { usable: boolean | null; expired: string }) {
  return (
    <div aria-live="polite">
      {usable === true && <p className="text-sm text-fg-muted">{T.current}</p>}
      {usable === false && (
        <p className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          {expired}
        </p>
      )}
    </div>
  );
}

/**
 * The exchange registry and protocol statuses, for reading only. The served copy is fetched
 * without touching the snapshot a close is verified against, and whether each list is still
 * relied on is decided in the browser after it loads, never when the page was built.
 */
export default function RegistryClient({ load = fetchServedRegistry, clock }: Props) {
  const [served, setServed] = useState<RegistrySnapshot | null | undefined>(undefined);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(clock ? clock() : new Date());
    let live = true;
    load().then(
      (snapshot) => live && setServed(snapshot),
      () => live && setServed(null)
    );
    return () => {
      live = false;
    };
  }, [load, clock]);

  const bundled = bundledRegistry();
  const snapshot = served ?? bundled;
  const bundledAddresses = new Set(bundled.entries.map((e) => e.address));
  const disputes = new Set(snapshot.memoTypeDisputes ?? []);
  const exchanges = groupByExchange(snapshot.entries);

  const source =
    served === undefined ? T.source.reading : served === null ? T.source.failed : T.source.served;

  return (
    <div className="mt-12 space-y-14">
      <div>
        <h2 className="mkt-display text-2xl font-bold text-white">{T.exchanges}</h2>
        <div className="mt-3 space-y-2">
          <p aria-live="polite" className="text-sm text-fg-muted">
            {source}
          </p>
          <DateLine lastVerified={snapshot.lastVerified} validUntil={snapshot.validUntil} />
          <Verdict
            usable={now === null ? null : isUsableAt(snapshot.validUntil, now)}
            expired={T.exchangesExpired(snapshot.validUntil)}
          />
          <p className="max-w-3xl text-sm leading-relaxed text-fg-muted">{T.unsigned}</p>
        </div>

        <ul className="mt-6 grid gap-4 md:grid-cols-2">
          {exchanges.map((group) => (
            <li
              key={`${group.name}|${group.domain}`}
              className="rounded-2xl border border-white/10 bg-white/[0.02] p-4"
            >
              <h3 className="text-sm font-semibold text-white">
                {group.name} <span className="font-normal text-fg-muted">{group.domain}</span>
              </h3>
              <ul className="mt-3 space-y-3">
                {group.entries.map((entry) => (
                  <li
                    key={entry.address}
                    className="border-t border-white/[0.06] pt-3 first:border-t-0 first:pt-0"
                  >
                    <p className="mkt-mono break-all text-label text-white/75">{entry.address}</p>
                    <p className="mt-1 text-sm text-fg-muted">
                      {memoRule(entry)} · {route(entry)}
                      {entry.network === "testnet" && T.testnetOnly}
                    </p>
                    {!bundledAddresses.has(entry.address) && (
                      <p className="mt-1 text-caption text-fg-subtle">{T.added}</p>
                    )}
                    {disputes.has(entry.address) && (
                      <p className="mt-1 text-caption text-warning">{T.disputed}</p>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2 className="mkt-display text-2xl font-bold text-white">{T.protocols}</h2>
        <div className="mt-3 space-y-2">
          <DateLine
            lastVerified={PROTOCOLS_VERIFIED.lastVerified}
            validUntil={PROTOCOLS_VERIFIED.validUntil}
          />
          <Verdict
            usable={now === null ? null : protocolStatusUsable(now)}
            expired={T.protocolsExpired(PROTOCOLS_VERIFIED.validUntil)}
          />
        </div>
        <table className="mt-6 w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 text-left text-sm">
          <caption className="sr-only">{T.protocolsCaption}</caption>
          <thead>
            <tr className="border-b border-white/10 text-fg-muted">
              <th scope="col" className="p-3 font-medium">
                {T.protocolColumn}
              </th>
              <th scope="col" className="p-3 font-medium">
                {T.statusColumn}
              </th>
            </tr>
          </thead>
          <tbody>
            {PROTOCOLS.map((protocol) => (
              <tr key={protocol.id} className="border-t border-white/[0.06]">
                <th scope="row" className="p-3 font-semibold text-white">
                  {protocol.name}
                </th>
                <td className="p-3 text-white/75">{STATUS_LABEL[protocol.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
