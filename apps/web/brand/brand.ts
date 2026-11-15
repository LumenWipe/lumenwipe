import { ACCENT, ACCENT_ON_LIGHT, BLACK, INK, MARK, VALUE, VALUE_ON_LIGHT, WHITE } from "./tokens";
import { WORDMARK_LUMEN, WORDMARK_WIDTH, WORDMARK_WIPE } from "./wordmark-outline";

interface Palette {
  outline: string;
  outlineOpacity: number;
  arc: string;
  spark: string;
  lumen: string;
  wipe: string;
}

const ON_DARK: Palette = {
  outline: ACCENT,
  outlineOpacity: 0.35,
  arc: VALUE,
  spark: ACCENT,
  lumen: WHITE,
  wipe: ACCENT,
};

const ON_LIGHT: Palette = {
  outline: ACCENT_ON_LIGHT,
  outlineOpacity: 0.45,
  arc: VALUE_ON_LIGHT,
  spark: ACCENT_ON_LIGHT,
  lumen: INK,
  wipe: ACCENT_ON_LIGHT,
};

function mono(color: string): Palette {
  return { outline: color, outlineOpacity: 1, arc: color, spark: color, lumen: color, wipe: color };
}

function markShapes(p: Palette, fill = "none", strokeWidth = 1.5): string {
  const o = MARK.outline;
  return [
    `<rect x="${o.x}" y="${o.y}" width="${o.size}" height="${o.size}" rx="${o.radius}" fill="${fill}" stroke="${p.outline}" stroke-opacity="${p.outlineOpacity}" stroke-width="${strokeWidth}"/>`,
    `<path d="${MARK.arc}" fill="none" stroke="${p.arc}" stroke-opacity="0.9" stroke-width="1.5" stroke-linecap="round"/>`,
    `<path d="${MARK.spark}" fill="${p.spark}"/>`,
  ].join("\n    ");
}

function wordShapes(p: Palette): string {
  return [
    `<path d="${WORDMARK_LUMEN}" fill="${p.lumen}"/>`,
    `<path d="${WORDMARK_WIPE}" fill="${p.wipe}"/>`,
  ].join("\n    ");
}

function svg(viewBox: string, width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" role="img" aria-label="LumenWipe">
  ${body}
</svg>
`;
}

/** The mark and the word side by side, 172 by 36. */
function horizontal(p: Palette): string {
  return svg(
    "0 0 172 36",
    172,
    36,
    `<g transform="translate(2,2)">
    ${markShapes(p)}
  </g>
  <g transform="translate(44,24)">
    ${wordShapes(p)}
  </g>`
  );
}

const STACKED_WIDTH = 120;

/** The mark above the word, centered. */
function stacked(p: Palette): string {
  const wordX = ((STACKED_WIDTH - WORDMARK_WIDTH) / 2).toFixed(2);
  return svg(
    `0 0 ${STACKED_WIDTH} 78`,
    STACKED_WIDTH,
    78,
    `<g transform="translate(36,2) scale(1.5)">
    ${markShapes(p)}
  </g>
  <g transform="translate(${wordX},70)">
    ${wordShapes(p)}
  </g>`
  );
}

/** The mark on a full-bleed ink square, with `pad` units of ink around the 32-unit mark. */
function onInkSquare(pad: number, size: number): string {
  const side = 32 + 2 * pad;
  return svg(
    `${-pad} ${-pad} ${side} ${side}`,
    size,
    size,
    `<rect x="${-pad}" y="${-pad}" width="${side}" height="${side}" fill="${INK}"/>
  ${markShapes({ ...ON_DARK, outlineOpacity: 0.55 }, INK, 1.25)}`
  );
}

/** The favicon and the `any` app icon: the mark filled with ink, transparent outside its corners. */
function favicon(): string {
  return svg("0 0 32 32", 32, 32, markShapes({ ...ON_DARK, outlineOpacity: 0.55 }, INK, 1.25));
}

/** Every vector asset, by its path relative to `apps/web`. The generator writes these files and
 *  a unit test checks the committed ones against it. */
export const BRAND_SVGS: Readonly<Record<string, string>> = {
  "brand/mark.svg": svg("0 0 32 32", 32, 32, markShapes(ON_DARK)),
  "brand/wordmark.svg": horizontal(ON_DARK),
  "brand/wordmark-light.svg": horizontal(ON_LIGHT),
  "brand/stacked.svg": stacked(ON_DARK),
  "brand/stacked-light.svg": stacked(ON_LIGHT),
  "brand/mono-white.svg": horizontal(mono(WHITE)),
  "brand/mono-black.svg": horizontal(mono(BLACK)),
  "brand/avatar.svg": onInkSquare(8, 400),
  "public/favicon.svg": favicon(),
  "../../docs/favicon.svg": favicon(),
  "../../docs/logo/dark.svg": horizontal(ON_DARK),
  "../../docs/logo/light.svg": horizontal(ON_LIGHT),
};

export interface RasterAsset {
  path: string;
  svg: string;
  width: number;
  height: number;
}

const scaled = (path: string, source: string, scale: number, w: number, h: number) => ({
  path,
  svg: source,
  width: w * scale,
  height: h * scale,
});

/** Every PNG, rendered from a vector above. */
export const BRAND_PNGS: readonly RasterAsset[] = [
  scaled("brand/mark.png", BRAND_SVGS["brand/mark.svg"], 16, 32, 32),
  scaled("brand/wordmark.png", BRAND_SVGS["brand/wordmark.svg"], 4, 172, 36),
  scaled("brand/wordmark-light.png", BRAND_SVGS["brand/wordmark-light.svg"], 4, 172, 36),
  scaled("brand/stacked.png", BRAND_SVGS["brand/stacked.svg"], 4, STACKED_WIDTH, 78),
  scaled("brand/stacked-light.png", BRAND_SVGS["brand/stacked-light.svg"], 4, STACKED_WIDTH, 78),
  scaled("brand/mono-white.png", BRAND_SVGS["brand/mono-white.svg"], 4, 172, 36),
  scaled("brand/mono-black.png", BRAND_SVGS["brand/mono-black.svg"], 4, 172, 36),
  { path: "brand/avatar.png", svg: onInkSquare(8, 512), width: 512, height: 512 },
  { path: "public/favicon-96x96.png", svg: favicon(), width: 96, height: 96 },
  { path: "public/apple-touch-icon.png", svg: onInkSquare(4, 180), width: 180, height: 180 },
  { path: "public/web-app-manifest-192x192.png", svg: favicon(), width: 192, height: 192 },
  { path: "public/web-app-manifest-512x512.png", svg: favicon(), width: 512, height: 512 },
  // A maskable icon is cropped to a circle of 80% of its side: the mark sits inside it.
  {
    path: "public/web-app-manifest-maskable-192x192.png",
    svg: onInkSquare(11, 192),
    width: 192,
    height: 192,
  },
  {
    path: "public/web-app-manifest-maskable-512x512.png",
    svg: onInkSquare(11, 512),
    width: 512,
    height: 512,
  },
];

/** The sizes packed into `public/favicon.ico`. */
export const FAVICON_ICO_SIZES = [16, 32, 48] as const;

const icon = (size: number, purpose: "any" | "maskable") => ({
  src: `/web-app-manifest-${purpose === "maskable" ? "maskable-" : ""}${size}x${size}.png`,
  sizes: `${size}x${size}`,
  type: "image/png",
  purpose,
});

export const MANIFEST = {
  name: "LumenWipe",
  short_name: "LumenWipe",
  icons: [icon(192, "any"), icon(512, "any"), icon(192, "maskable"), icon(512, "maskable")],
  theme_color: INK,
  background_color: INK,
  display: "standalone",
} as const;

export const MANIFEST_JSON = `${JSON.stringify(MANIFEST, null, 2)}\n`;

/** An SVG as a data URI, for an `<img>` inside a generated image. */
export function svgDataUri(source: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
}
