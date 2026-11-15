import { ImageResponse } from "next/og";
import { BRAND_SVGS, svgDataUri } from "@/brand/brand";
import { ACCENT, INK, VALUE } from "@/brand/tokens";
import { SHARE_IMAGE } from "@/lib/site/pages";
import { siteOrigin } from "@/lib/site/url";
import { RESERVE_EXAMPLE, RESERVE_EXAMPLE_TOTAL } from "@/lib/site/numbers";

export const SHARE_IMAGE_SIZE = { width: SHARE_IMAGE.width, height: SHARE_IMAGE.height };
export const SHARE_IMAGE_TYPE = "image/png";

const WORDMARK = svgDataUri(BRAND_SVGS["brand/wordmark.svg"]);
const MUTED = "rgba(255,255,255,0.62)";

interface ShareImageProps {
  eyebrow: string;
  headline: string;
  /** Show the example account's plan and the XLM it recovers. */
  plan?: boolean;
}

/** A branded 1200 by 630 share card: the logo, a headline, and optionally the example plan. */
export function shareImage({ eyebrow, headline, plan = false }: ShareImageProps): ImageResponse {
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
            {RESERVE_EXAMPLE.map((row) => (
              <div key={row.label} style={{ display: "flex", width: 520 }}>
                <div style={{ display: "flex", flexGrow: 1 }}>{row.label}</div>
                <div style={{ display: "flex", color: VALUE }}>{row.xlm.toFixed(2)} XLM</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ display: "flex", fontSize: 26, color: MUTED }}>Recovered on close</div>
            <div style={{ display: "flex", fontSize: 72, color: VALUE }}>
              {RESERVE_EXAMPLE_TOTAL.toFixed(2)} XLM
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
