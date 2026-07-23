"use client";

import { useFeed } from "@/hooks/useFeed";
import StatsHero from "./StatsHero";
import RecentFeed from "./RecentFeed";
import ConstellationChart from "./ConstellationChart";
import CalendarHeatmap from "./CalendarHeatmap";
import DistributionStrip from "./DistributionStrip";
import Reveal from "@/components/marketing/Reveal";
import { ExternalLink } from "lucide-react";

export default function StatsClient() {
  const { feed, stale } = useFeed();

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 pb-24 pt-12 lg:px-8">
      {/* eyebrow */}
      <Reveal>
        <div className="flex items-center justify-between">
          <div>
            <span className="mkt-eyebrow inline-flex items-center gap-2 text-stellar/90">
              <span className="h-px w-6 bg-stellar/50" />
              On-chain activity
            </span>
            <h1 className="mkt-display mt-3 text-3xl font-bold text-white sm:text-4xl">
              Real numbers. Verifiable on Stellar.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/65">
              Every transaction on this page is an{" "}
              <code className="rounded bg-white/5 px-1 py-0.5 mkt-mono text-[0.78rem] text-white/75">
                ACCOUNT_MERGE
              </code>{" "}
              operation recorded on the Stellar blockchain. Click any hash to verify.
            </p>
          </div>
          {stale && (
            <span className="mkt-mono rounded-full border border-warning/30 bg-warning/5 px-3 py-1 text-[0.65rem] text-warning/70">
              Data may be stale
            </span>
          )}
        </div>
      </Reveal>

      {/* hero counters */}
      <Reveal delay={60}>
        <StatsHero feed={feed} />
      </Reveal>

      {/* constellation + feed side by side */}
      <Reveal delay={100}>
        <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <ConstellationChart feed={feed} />
          <RecentFeed feed={feed} />
        </div>
      </Reveal>

      {/* calendar heatmap */}
      <Reveal delay={140}>
        <CalendarHeatmap feed={feed} />
      </Reveal>

      {/* distribution strip */}
      <Reveal delay={180}>
        <DistributionStrip feed={feed} />
      </Reveal>

      {/* verification note */}
      <Reveal delay={200}>
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/6 bg-white/[0.015] px-6 py-5 text-center sm:flex-row sm:text-left">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03]">
            <ExternalLink className="h-4 w-4 text-stellar" />
          </div>
          <div className="flex-1">
            <p className="text-[0.82rem] leading-relaxed text-white/55">
              Each close counted here was completed through LumenWipe. Before being recorded, the
              backend confirms the transaction hash is a successful{" "}
              <code className="mkt-mono text-[0.75rem] text-white/70">ACCOUNT_MERGE</code> on the
              Stellar blockchain - merges done outside LumenWipe are not included. Every row in the
              feed links directly to stellar.expert so you can verify each one independently.
            </p>
          </div>
          <a
            href="https://stellar.expert/explorer/public"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 mkt-mono rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[0.68rem] text-white/50 transition-colors hover:border-stellar/30 hover:text-stellar"
          >
            stellar.expert ↗
          </a>
        </div>
      </Reveal>
    </div>
  );
}
