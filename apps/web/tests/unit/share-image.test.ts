import { describe, expect, test } from "bun:test";
import { postShareCard, siteShareCard, SHARE_IMAGE_SIZE } from "@/components/seo/ShareImage";
import { getAllPostMetas, getAllSlugs, getPost } from "@/lib/blog";
import { shareImageFor } from "@/lib/site/pages";
import { BASE_RESERVE_XLM } from "@/lib/site/reserve";
import { reserveExample } from "@/lib/site/numbers";

const SLUG = "how-do-i-remove-a-trustline-on-stellar";

// Rendered in a child process: next/og loads its wasm through fetch, which other suites replace.
// Each locale's site and post card, as its route serves it and as drawn from that locale's card.
const RENDER = `
const { postShareCard, shareImage, siteShareCard } = await import("@/components/seo/ShareImage");
const { getPost } = await import("@/lib/blog");
const routes = {
  en: { site: "./app/opengraph-image.tsx", post: "./app/(marketing)/blog/[slug]/share.png/route.tsx" },
  es: { site: "./app/es/opengraph-image.tsx", post: "./app/(marketing-es)/es/blog/[slug]/share.png/route.tsx" },
};
const bytes = async (response) => Buffer.from(await response.arrayBuffer()).toString("base64");
const out = {};
for (const [locale, route] of Object.entries(routes)) {
  const site = await import(route.site);
  const post = await import(route.post);
  out[locale] = {
    alt: site.alt,
    slugs: post.generateStaticParams().map((p) => p.slug),
    site: await bytes(site.default()),
    post: await bytes(await post.GET(new Request("http://x"), { params: Promise.resolve({ slug: ${JSON.stringify(SLUG)} }) })),
    siteCard: await bytes(shareImage(siteShareCard(locale))),
    postCard: await bytes(shareImage(postShareCard(getPost(${JSON.stringify(SLUG)}, locale), locale))),
  };
}
console.log(JSON.stringify(out));
`;

interface Rendered {
  alt: string;
  slugs: string[];
  site: Buffer;
  post: Buffer;
  siteCard: Buffer;
  postCard: Buffer;
}

function renderRoutes(): Record<"en" | "es", Rendered> {
  const child = Bun.spawnSync([process.execPath, "-e", RENDER], { cwd: process.cwd() });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const raw = JSON.parse(child.stdout.toString()) as Record<"en" | "es", Record<string, unknown>>;
  const read = (locale: "en" | "es"): Rendered => {
    const r = raw[locale];
    const png = (key: string) => Buffer.from(r[key] as string, "base64");
    return {
      alt: r.alt as string,
      slugs: r.slugs as string[],
      site: png("site"),
      post: png("post"),
      siteCard: png("siteCard"),
      postCard: png("postCard"),
    };
  };
  return { en: read("en"), es: read("es") };
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe("the site share card", () => {
  test("keeps the English copy", () => {
    expect(siteShareCard("en")).toEqual({
      eyebrow: "Example account",
      headline: "Close the account. Keep the lumens.",
      plan: { rows: reserveExample("en"), recovered: "Recovered on close" },
    });
  });

  test("reads in Spanish, with the Spanish example plan", () => {
    expect(siteShareCard("es")).toEqual({
      eyebrow: "Cuenta de ejemplo",
      headline: "Cierra la cuenta. Quédate con los lumens.",
      plan: { rows: reserveExample("es"), recovered: "Recuperado al cerrar" },
    });
    const total = siteShareCard("es").plan!.rows.reduce((sum, row) => sum + row.xlm, 0);
    expect(total).toBe(10 * BASE_RESERVE_XLM);
  });
});

describe("a post's share card", () => {
  test("names the blog and the category in the post's locale, and its own title", () => {
    for (const { slug } of getAllPostMetas("es")) {
      const english = getPost(slug);
      const spanish = getPost(slug, "es");
      expect(postShareCard(english, "en")).toEqual({
        eyebrow: `Blog · ${english.category}`,
        headline: english.title,
      });
      expect(postShareCard(spanish, "es")).toEqual({
        eyebrow: `Blog · ${{ Technical: "Técnico", Updates: "Novedades", Guides: "Guías" }[spanish.category]}`,
        headline: spanish.title,
      });
      expect(spanish.title).not.toBe(english.title);
    }
  });
});

describe("the share image routes", () => {
  const rendered = renderRoutes();

  for (const locale of ["en", "es"] as const) {
    test(`serve the ${locale} cards, PNGs of the share image size`, () => {
      const r = rendered[locale];
      expect(r.alt).toBe(shareImageFor(locale).alt);
      expect(r.slugs).toEqual(getAllSlugs(locale));
      expect(r.site.equals(r.siteCard)).toBe(true);
      expect(r.post.equals(r.postCard)).toBe(true);
      for (const png of [r.site, r.post]) {
        expect(pngSize(png)).toEqual(SHARE_IMAGE_SIZE);
        expect(png.length).toBeLessThan(100_000);
      }
    });
  }

  test("differ by locale", () => {
    expect(rendered.es.site.equals(rendered.en.site)).toBe(false);
    expect(rendered.es.post.equals(rendered.en.post)).toBe(false);
  });
});
