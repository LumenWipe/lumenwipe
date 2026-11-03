export type Rgb = [number, number, number];

export function rootVars(css: string): Record<string, string> {
  const start = css.indexOf(":root {");
  const end = css.indexOf("\n  }\n", start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

export function toRgb(hsl: string): Rgb {
  const m = hsl.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) throw new Error(`not an "H S% L%" triple: ${hsl}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  ) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function luminance(hsl: string): number {
  return relativeLuminance(toRgb(hsl));
}

export function ratio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

export const SURFACES = ["bg", "surface", "surface-raised", "surface-sunken"] as const;

export const TEXT_MINIMUMS: readonly (readonly [string, number])[] = [
  ...["fg", "fg-muted", "fg-subtle", "accent", "value", "success", "warning"].map(
    (fg) => [fg, 4.5] as const
  ),
  ["fg-disabled", 3],
  ["danger-fg", 7],
  ["line-strong", 3],
  ["edge", 3],
  ["focus", 3],
];

export const FILL_PAIRS: readonly { fg: string; bg: string; min: number }[] = [
  { fg: "accent-fg", bg: "accent", min: 4.5 },
  { fg: "value-fg", bg: "value", min: 4.5 },
  { fg: "warning-fg", bg: "warning", min: 4.5 },
  { fg: "danger-on-fill", bg: "danger", min: 4.5 },
];

export interface Pair {
  fg: string;
  bg: string;
  min: number;
}

export const PAIRS: readonly Pair[] = [
  ...TEXT_MINIMUMS.flatMap(([fg, min]) => SURFACES.map((bg) => ({ fg, bg, min }))),
  ...FILL_PAIRS,
];

export const TINT_SURFACES = ["bg", "surface", "surface-raised"] as const;
export const TINT_MINIMUM = 7;

function lookup(vars: Record<string, string>, name: string): string {
  const value = vars[name];
  if (value === undefined) throw new Error(`token --${name} is missing from globals.css`);
  return value;
}

export function measure(vars: Record<string, string>, fg: string, bg: string): number {
  return Number(ratio(lookup(vars, fg), lookup(vars, bg)).toFixed(2));
}

/** danger-fg over the danger fill at 10% on a surface, the tint a danger callout uses. */
export function measureDangerTint(vars: Record<string, string>, surface: string): number {
  const fill = toRgb(lookup(vars, "danger"));
  const base = toRgb(lookup(vars, surface));
  const tint = fill.map((c, i) => c * 0.1 + base[i]! * 0.9) as Rgb;
  const text = luminance(lookup(vars, "danger-fg"));
  return (text + 0.05) / (relativeLuminance(tint) + 0.05);
}

function table(header: string[], rows: string[][]): string {
  return [header, header.map(() => "---"), ...rows]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}

const code = (name: string): string => `\`${name}\``;
const shown = (value: number): string => `${value.toFixed(2)}:1`;

export function renderContrastTables(vars: Record<string, string>): string {
  const onSurfaces = table(
    ["Foreground", ...SURFACES.map(code), "Minimum"],
    TEXT_MINIMUMS.map(([fg, min]) => [
      code(fg),
      ...SURFACES.map((bg) => shown(measure(vars, fg, bg))),
      `${min}:1`,
    ])
  );
  const fills = table(
    ["Foreground", "Fill", "Ratio", "Minimum"],
    FILL_PAIRS.map((p) => [code(p.fg), code(p.bg), shown(measure(vars, p.fg, p.bg)), `${p.min}:1`])
  );
  const tint = table(
    ["Surface", "Ratio", "Minimum"],
    TINT_SURFACES.map((s) => [
      code(s),
      shown(Number(measureDangerTint(vars, s).toFixed(2))),
      `${TINT_MINIMUM}:1`,
    ])
  );
  return [
    "Foreground tokens on each surface:",
    onSurfaces,
    "Text on a filled background:",
    fills,
    "`danger-fg` on the danger callout tint (`danger` at 10% over the surface):",
    tint,
  ].join("\n\n");
}
