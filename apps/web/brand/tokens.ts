/** The one dark value: the page background (`--bg` in app/globals.css), the favicon fill, the
 *  manifest theme and background colors and `viewport.themeColor`. */
export const INK = "#080D0F";
export const WHITE = "#FFFFFF";
export const BLACK = "#000000";

/** The mark's cyan and gold on a dark background, and the darker steps used on white. */
export const ACCENT = "#00B0F0";
export const VALUE = "#FAB623";
export const ACCENT_ON_LIGHT = "#0098D6";
export const VALUE_ON_LIGHT = "#E0961A";

/** The mark, in a 32 by 32 box: a rounded square outline, a four-point spark and a sweep arc. */
export const MARK = {
  outline: { x: 1, y: 1, size: 30, radius: 8 },
  arc: "M7 22c4.5 3 13.5 3 18 0",
  spark:
    "M16 6.5c.7 4.2 2.3 5.8 6.5 6.5-4.2.7-5.8 2.3-6.5 6.5-.7-4.2-2.3-5.8-6.5-6.5 4.2-.7 5.8-2.3 6.5-6.5Z",
} as const;
