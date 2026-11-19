import { ImageResponse } from "next/og";
import { BRAND_SVGS, svgDataUri } from "@/brand/brand";
import { ACCENT, INK, VALUE } from "@/brand/tokens";
import type { Post } from "@/lib/blog";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";
import { SITE } from "@/lib/i18n/messages/site";
import { shareImageFor } from "@/lib/site/pages";
import { siteOrigin } from "@/lib/site/url";
import { reserveExample, type ReserveRow } from "@/lib/site/numbers";

const { width, height } = shareImageFor("en");
export const SHARE_IMAGE_SIZE = { width, height };
export const SHARE_IMAGE_TYPE = "image/png";

const WORDMARK = svgDataUri(BRAND_SVGS["brand/wordmark.svg"]);
const MUTED = "rgba(255,255,255,0.62)";

export interface ShareCard {
  eyebrow: string;
  headline: string;
  /** The example account's plan and the label of the XLM it recovers, shown under the headline. */
  plan?: { rows: readonly ReserveRow[]; recovered: string };
}

/** The site-wide card in `locale`: the example account and the XLM its close recovers. */
export function siteShareCard(locale: Locale): ShareCard {
  const { eyebrow, headline, recovered } = SITE[locale].metadata.shareCard;
  return { eyebrow, headline, plan: { rows: reserveExample(locale), recovered } };
}

/** A blog post's card in `locale`: its category and its title. */
export function postShareCard(post: Pick<Post, "category" | "title">, locale: Locale): ShareCard {
  const blog = BLOG[locale];
  return { eyebrow: `${blog.eyebrow} · ${blog.categories[post.category]}`, headline: post.title };
}

/** A branded 1200 by 630 share card: the logo, a headline, and optionally the example plan. */
export function shareImage({ eyebrow, headline, plan }: ShareCard): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: 72,
        background: INK,
        color: "#FFFFFF",
        fontFamily: "sans-serif",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
      <img src={WORDMARK} width={344} height={72} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: 26, color: ACCENT, letterSpacing: 2 }}>
          {eyebrow.toUpperCase()}
        </div>
        <div style={{ display: "flex", marginTop: 16, fontSize: plan ? 64 : 56, lineHeight: 1.1 }}>
          {headline}
        </div>
      </div>
      {plan ? (
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 26, color: MUTED }}>
            {plan.rows.map((row) => (
              <div key={row.label} style={{ display: "flex", width: 520 }}>
                <div style={{ display: "flex", flexGrow: 1 }}>{row.label}</div>
                <div style={{ display: "flex", color: VALUE }}>{row.xlm.toFixed(2)} XLM</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ display: "flex", fontSize: 26, color: MUTED }}>{plan.recovered}</div>
            <div style={{ display: "flex", fontSize: 72, color: VALUE }}>
              {plan.rows.reduce((sum, row) => sum + row.xlm, 0).toFixed(2)} XLM
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
          {new URL(siteOrigin()).host}
        </div>
      )}
    </div>,
    SHARE_IMAGE_SIZE
  );
}
