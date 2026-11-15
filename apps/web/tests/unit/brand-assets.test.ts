import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_PNGS, BRAND_SVGS, FAVICON_ICO_SIZES, MANIFEST, MANIFEST_JSON } from "@/brand/brand";
import { INK } from "@/brand/tokens";
import { ROOT_VIEWPORT } from "@/lib/site/root-metadata";

const WEB = join(import.meta.dir, "..", "..");
const REGENERATE = "out of date: run `bun run brand:assets` in apps/web";

/** Width and height from a PNG's IHDR chunk. */
function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe("the brand source", () => {
  for (const [path, svg] of Object.entries(BRAND_SVGS)) {
    test(`${path} matches it`, () => {
      expect(readFileSync(join(WEB, path), "utf8"), `${path} is ${REGENERATE}`).toBe(svg);
    });
  }

  test("public/site.webmanifest matches it", () => {
    expect(readFileSync(join(WEB, "public", "site.webmanifest"), "utf8")).toBe(MANIFEST_JSON);
  });

  for (const asset of BRAND_PNGS) {
    test(`${asset.path} is a ${asset.width} by ${asset.height} PNG`, () => {
      expect(pngSize(readFileSync(join(WEB, asset.path)))).toEqual({
        width: asset.width,
        height: asset.height,
      });
    });
  }

  test("public/favicon.ico holds one PNG per size", () => {
    const ico = readFileSync(join(WEB, "public", "favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(FAVICON_ICO_SIZES.length);
    FAVICON_ICO_SIZES.forEach((size, i) => {
      const entry = 6 + 16 * i;
      const offset = ico.readUInt32LE(entry + 12);
      const length = ico.readUInt32LE(entry + 8);
      expect(pngSize(ico.subarray(offset, offset + length))).toEqual({ width: size, height: size });
    });
  });

  test("brand/ holds every variant in SVG and PNG, with its usage note", () => {
    for (const name of [
      "mark",
      "wordmark",
      "wordmark-light",
      "stacked",
      "mono-white",
      "mono-black",
      "avatar",
    ]) {
      for (const ext of ["svg", "png"])
        expect(existsSync(join(WEB, "brand", `${name}.${ext}`))).toBe(true);
    }
    const note = readFileSync(join(WEB, "brand", "README.md"), "utf8");
    for (const heading of ["## Clear space and minimum size", "## The wordmark font"]) {
      expect(note).toContain(heading);
    }
    expect(note).toContain("SIL Open Font License");
  });
});

// That the theme color equals the --bg token is checked in reduced-motion.test.ts.
describe("one dark value", () => {
  test("the favicon fill, the manifest colors and the browser theme color are ink", () => {
    for (const path of ["public/favicon.svg", "../../docs/favicon.svg"]) {
      expect(/<rect [^>]*fill="([^"]+)"/.exec(readFileSync(join(WEB, path), "utf8"))?.[1]).toBe(
        INK
      );
    }
    expect(MANIFEST.theme_color).toBe(INK);
    expect(MANIFEST.background_color).toBe(INK);
    expect(ROOT_VIEWPORT.themeColor).toBe(INK);
  });
});

describe("the web manifest", () => {
  const manifest = JSON.parse(readFileSync(join(WEB, "public", "site.webmanifest"), "utf8"));

  test("names the app and opens standalone", () => {
    expect(manifest).toMatchObject({
      name: "LumenWipe",
      short_name: "LumenWipe",
      display: "standalone",
    });
  });

  test("lists an any and a maskable icon at 192 and 512, each a PNG of that size", () => {
    const icons: { src: string; sizes: string; type: string; purpose: string }[] = manifest.icons;
    for (const purpose of ["any", "maskable"]) {
      expect(
        icons
          .filter((i) => i.purpose === purpose)
          .map((i) => i.sizes)
          .sort()
      ).toEqual(["192x192", "512x512"]);
    }
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngSize(readFileSync(join(WEB, "public", icon.src)))).toEqual({ width, height });
    }
  });
});
