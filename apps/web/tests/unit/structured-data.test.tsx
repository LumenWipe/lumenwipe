import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { render } from "@testing-library/react";
import LandingPage from "@/app/(marketing)/page";
import FaqPage from "@/app/(marketing)/faq/page";
import BlogPage from "@/app/(marketing)/blog/page";
import SpanishLandingPage from "@/app/(marketing-es)/es/page";
import SpanishFaqPage from "@/app/(marketing-es)/es/faq/page";
import SpanishSecurityPage from "@/app/(marketing-es)/es/security/page";
import SpanishHowItWorksPage from "@/app/(marketing-es)/es/how-it-works/page";
import SpanishBlogPage from "@/app/(marketing-es)/es/blog/page";
import PostPage, { postMetadata } from "@/components/blog/PostPage";
import SecurityPage from "@/app/(marketing)/security/page";
import HowItWorksPage from "@/app/(marketing)/how-it-works/page";
import Faq, { faqItems } from "@/components/marketing/Faq";
import JsonLd from "@/components/seo/JsonLd";
import { getAllPostMetas, getPost } from "@/lib/blog";
import { LANDING } from "@/lib/i18n/messages/landing";
import { GITHUB_URL } from "@/lib/site/navigation";
import { nodeText } from "@/lib/site/node-text";
import { localePath, postShareImage } from "@/lib/site/pages";
import { feature, FEATURES, LIVE_EXIT_PROTOCOLS, listNames } from "@/lib/site/status";
import {
  blogJsonLd,
  faqJsonLd,
  homeJsonLd,
  liveFeatureList,
  postJsonLd,
  serializeJsonLd,
} from "@/lib/site/structured-data";
import { siteOrigin, siteUrl } from "@/lib/site/url";
import { renderMarketing } from "./fixtures/marketing";

type Node = Record<string, unknown> & { "@type": string };

/** Every JSON-LD block in rendered HTML, parsed. */
function blocksIn(root: HTMLElement): Node[] {
  return [...root.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
    const doc = JSON.parse(s.textContent ?? "");
    expect(doc["@context"]).toBe("https://schema.org");
    return doc["@graph"] as Node[];
  });
}

/** The JsonLd elements in a server component's returned tree, rendered as they would be. */
function blocksInTree(tree: ReactNode): Node[] {
  const found: ReactElement<{ data: never }>[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isValidElement<{ children?: ReactNode; data: never }>(node)) {
      if (node.type === JsonLd) found.push(node);
      else walk(node.props.children);
    }
  };
  walk(tree);
  return found.flatMap((el) => blocksIn(render(<JsonLd {...el.props} />).container));
}

const byType = (nodes: Node[], type: string) => nodes.filter((n) => n["@type"] === type);
const one = (nodes: Node[], type: string) => {
  const matches = byType(nodes, type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

/** Every URL a block names: `url`, `@id`, `item` and `image`, at any depth. */
function urlsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => urlsIn(v, out));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "sameAs") continue;
      if (["url", "@id", "item", "image"].includes(key) && typeof v === "string") out.push(v);
      else if (key === "image" && Array.isArray(v)) out.push(...(v as string[]));
      else urlsIn(v, out);
    }
  }
  return out;
}

const POST = getAllPostMetas()[0]!;
const PAGES = {
  home: blocksIn(renderMarketing(<LandingPage />)),
  faq: blocksIn(renderMarketing(<FaqPage />)),
  blog: blocksIn(renderMarketing(<BlogPage />)),
  post: blocksInTree(PostPage({ locale: "en", slug: POST.slug })),
};

describe("every block", () => {
  for (const [page, nodes] of Object.entries(PAGES)) {
    test(`on the ${page} page names only absolute URLs on the site origin, none empty`, () => {
      const urls = urlsIn(nodes);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url).not.toBe("");
        expect(new URL(url).origin).toBe(siteOrigin());
      }
    });
  }

  test("only the home, FAQ, blog and post pages emit structured data", () => {
    for (const page of [
      <SecurityPage key="s" />,
      <SpanishSecurityPage key="es-s" />,
      <HowItWorksPage key="h" />,
      <SpanishHowItWorksPage key="es-h" />,
    ]) {
      expect(blocksIn(renderMarketing(page))).toEqual([]);
    }
  });
});

describe("the home page", () => {
  const nodes = PAGES.home;

  test("describes the organization, with its logo and repository", () => {
    const org = one(nodes, "Organization");
    expect(org).toMatchObject({ name: "LumenWipe", url: siteUrl("/"), sameAs: [GITHUB_URL] });
    expect(org.logo).toMatchObject({
      "@type": "ImageObject",
      url: siteUrl("/web-app-manifest-512x512.png"),
    });
  });

  test("describes the site and the app, published by the organization", () => {
    const org = one(nodes, "Organization");
    expect(one(nodes, "WebSite")).toMatchObject({
      url: siteUrl("/"),
      publisher: { "@id": org["@id"] },
    });
    const app = one(nodes, "WebApplication");
    expect(app).toMatchObject({
      name: "LumenWipe",
      url: siteUrl("/"),
      applicationCategory: "FinanceApplication",
      publisher: { "@id": org["@id"] },
    });
    expect(String(app.description).length).toBeGreaterThan(0);
  });

  test("lists only what the status registry has live, every live feature included", () => {
    const list = one(nodes, "WebApplication").featureList as string[];
    expect(list).toEqual(liveFeatureList("en"));
    for (const f of FEATURES) expect(list.includes(f.title)).toBe(f.status === "live");
    if (LIVE_EXIT_PROTOCOLS.length > 0) {
      expect(list.at(-1)).toBe(`Position exits: ${listNames(LIVE_EXIT_PROTOCOLS)}`);
    }
  });
});

const FAQ_PAGES = [
  { locale: "en", page: PAGES.faq, inLanguage: "en" },
  { locale: "es", page: blocksIn(renderMarketing(<SpanishFaqPage />)), inLanguage: "es-419" },
] as const;

for (const { locale, page, inLanguage } of FAQ_PAGES) {
  describe(`the FAQ page in ${locale}`, () => {
    const faq = one(page, "FAQPage");
    const questions = faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[];

    test("is a FAQPage in its language with one question per item", () => {
      expect(faq.url).toBe(siteUrl(localePath(locale, "/faq")));
      expect(faq.inLanguage).toBe(inLanguage);
      expect(questions.map((q) => q.name)).toEqual(faqItems(locale).map((i) => i.q));
      for (const q of questions) expect(q.acceptedAnswer.text.length).toBeGreaterThan(20);
    });

    test("answers each question with exactly the text the accordion renders", () => {
      const panels = [
        ...renderMarketing(<Faq locale={locale} />).querySelectorAll('[role="region"]'),
      ];
      expect(panels).toHaveLength(questions.length);
      panels.forEach((panel, i) => {
        const copy = panel.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(".sr-only").forEach((el) => el.remove());
        const shown = (copy.textContent ?? "").replace(/\s+/g, " ").trim();
        expect(questions[i]!.acceptedAnswer.text).toBe(shown);
      });
    });
  });
}

describe("the blog index", () => {
  test("is a Blog listing every post, with its breadcrumb", () => {
    const blog = one(PAGES.blog, "Blog");
    expect(blog.url).toBe(siteUrl("/blog"));
    expect((blog.blogPost as { url: string }[]).map((p) => p.url)).toEqual(
      getAllPostMetas().map((p) => siteUrl(`/blog/${p.slug}`))
    );
    expect(one(PAGES.blog, "BreadcrumbList").itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: siteUrl("/") },
      { "@type": "ListItem", position: 2, name: "Blog", item: siteUrl("/blog") },
    ]);
  });
});

describe("a post", () => {
  const post = getPost(POST.slug);
  const canonical = siteUrl(`/blog/${post.slug}`);

  test("is a complete Article", () => {
    const article = one(PAGES.post, "Article");
    expect(article).toMatchObject({
      headline: post.title,
      description: post.description,
      datePublished: `${post.publishedAt}T00:00:00Z`,
      dateModified: `${post.updatedAt}T00:00:00Z`,
      image: [siteUrl(postShareImage(post.slug, post.title).url)],
      mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
      author: { "@type": "Organization", name: "LumenWipe" },
    });
    expect(article.publisher).toMatchObject({
      "@type": "Organization",
      name: "LumenWipe",
      logo: { "@type": "ImageObject", url: siteUrl("/web-app-manifest-512x512.png") },
    });
  });

  test("dates the article, the blog's entries and Open Graph as UTC timestamps", async () => {
    const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T00:00:00Z$/;
    const article = one(PAGES.post, "Article");
    const entries = one(PAGES.blog, "Blog").blogPost as Record<string, unknown>[];
    const og = postMetadata("en", post.slug).openGraph as Record<string, unknown>;
    for (const value of [
      article.datePublished,
      article.dateModified,
      ...entries.flatMap((e) => [e.datePublished, e.dateModified]),
      og.publishedTime,
      og.modifiedTime,
    ]) {
      expect(value).toMatch(TIMESTAMP);
    }
    expect(og.modifiedTime).toBe(`${post.updatedAt}T00:00:00Z`);
  });

  test("has a breadcrumb ending at the post", () => {
    const crumbs = one(PAGES.post, "BreadcrumbList").itemListElement as {
      item: string;
      name: string;
    }[];
    expect(crumbs.map((c) => c.item)).toEqual([siteUrl("/"), siteUrl("/blog"), canonical]);
    expect(crumbs.at(-1)!.name).toBe(post.title);
  });
});

// The page-level CreativeWork nodes, which carry their content's language, and every property each
// node type may use: what the Rich Results Test reads, checked here as far as it can be offline.
const IN_LANGUAGE_TYPES = ["WebSite", "WebApplication", "FAQPage", "Blog", "Article"];
const SCHEMA: Record<string, { required: string[]; optional?: string[] }> = {
  Organization: { required: ["name", "url"], optional: ["@id", "logo", "sameAs"] },
  ImageObject: { required: ["url", "width", "height"] },
  WebSite: { required: ["@id", "name", "url", "inLanguage", "publisher"] },
  WebApplication: {
    required: [
      "name",
      "url",
      "description",
      "inLanguage",
      "applicationCategory",
      "operatingSystem",
      "isAccessibleForFree",
      "featureList",
      "publisher",
    ],
  },
  FAQPage: { required: ["url", "inLanguage", "mainEntity"] },
  Question: { required: ["name", "acceptedAnswer"] },
  Answer: { required: ["text"] },
  Blog: { required: ["name", "url", "inLanguage", "publisher", "blogPost"] },
  BlogPosting: { required: ["headline", "url", "datePublished", "dateModified"] },
  Article: {
    required: [
      "headline",
      "description",
      "inLanguage",
      "datePublished",
      "dateModified",
      "image",
      "mainEntityOfPage",
      "url",
      "author",
      "publisher",
      "keywords",
    ],
  },
  WebPage: { required: ["@id"] },
  BreadcrumbList: { required: ["itemListElement"] },
  ListItem: { required: ["position", "name", "item"] },
};

/** Every typed node in a block, at any depth, and the props it sets. A reference such as
 *  `{ "@id": ... }` has no type and is skipped. */
function typedNodes(value: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(value)) value.forEach((v) => typedNodes(v, out));
  else if (value && typeof value === "object") {
    if ("@type" in value) out.push(value as Node);
    Object.values(value).forEach((v) => typedNodes(v, out));
  }
  return out;
}

describe("the language of the structured data", () => {
  const TOP = {
    home: ["WebSite", "WebApplication"],
    faq: ["FAQPage"],
    blog: ["Blog"],
    post: ["Article"],
  };

  for (const [page, types] of Object.entries(TOP)) {
    test(`the ${page} page declares its content as English`, () => {
      const nodes = PAGES[page as keyof typeof PAGES];
      for (const type of types) expect(one(nodes, type).inLanguage).toBe("en");
    });
  }

  test("every node on every page has its type's required properties and no others", () => {
    for (const nodes of Object.values(PAGES)) {
      for (const node of typedNodes(nodes)) {
        const shape = SCHEMA[node["@type"]];
        expect(shape).toBeDefined();
        const keys = Object.keys(node).filter((k) => k !== "@type");
        for (const key of shape!.required) expect(keys).toContain(key);
        for (const key of keys) {
          expect([...shape!.required, ...(shape!.optional ?? [])]).toContain(key);
        }
        expect("inLanguage" in node).toBe(IN_LANGUAGE_TYPES.includes(node["@type"]));
      }
    }
  });

  test("a Spanish page declares es-419 and its own URL", () => {
    const post = getPost(POST.slug);
    const docs = {
      home: homeJsonLd("Descripción", "es"),
      faq: faqJsonLd(faqItems("es"), "es"),
      blog: blogJsonLd(getAllPostMetas(), "es"),
      post: postJsonLd(post, "es"),
    };
    for (const [page, types] of Object.entries(TOP)) {
      const nodes = docs[page as keyof typeof docs]["@graph"] as Node[];
      for (const type of types) expect(one(nodes, type).inLanguage).toBe("es-419");
    }
    expect(one(docs.faq["@graph"] as Node[], "FAQPage").url).toBe(siteUrl("/es/faq"));
    expect(one(docs.blog["@graph"] as Node[], "Blog").url).toBe(siteUrl("/es/blog"));
    expect(one(docs.post["@graph"] as Node[], "Article").url).toBe(
      siteUrl(`/es/blog/${post.slug}`)
    );
  });

  test("the Spanish blog lists its own posts at their Spanish URLs, under a Spanish breadcrumb", () => {
    const nodes = blocksIn(renderMarketing(<SpanishBlogPage />));
    const blog = one(nodes, "Blog");
    expect(blog).toMatchObject({ url: siteUrl("/es/blog"), inLanguage: "es-419" });
    const posts = getAllPostMetas("es");
    expect(posts.length).toBeGreaterThan(0);
    expect((blog.blogPost as { url: string }[]).map((p) => p.url)).toEqual(
      posts.map((p) => siteUrl(`/es/blog/${p.slug}`))
    );
    expect(one(nodes, "BreadcrumbList").itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Inicio", item: siteUrl("/es") },
      { "@type": "ListItem", position: 2, name: "Blog", item: siteUrl("/es/blog") },
    ]);
  });

  test("a Spanish post is a Spanish Article at its own URL, with its English post's image", () => {
    const { slug } = getAllPostMetas("es")[0]!;
    const post = getPost(slug, "es");
    const canonical = siteUrl(`/es/blog/${slug}`);
    const nodes = blocksInTree(PostPage({ locale: "es", slug }));
    expect(one(nodes, "Article")).toMatchObject({
      headline: post.title,
      inLanguage: "es-419",
      url: canonical,
      mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
      image: [siteUrl(postShareImage(slug, getPost(slug).title).url)],
    });
    const crumbs = one(nodes, "BreadcrumbList").itemListElement as { item: string }[];
    expect(crumbs.map((c) => c.item)).toEqual([siteUrl("/es"), siteUrl("/es/blog"), canonical]);
  });

  test("the Spanish landing declares es-419, its own URLs and the Spanish feature names", () => {
    const description = LANDING.es.description(feature("exchange-close").status === "live");
    const nodes = blocksIn(renderMarketing(<SpanishLandingPage />));
    expect(nodes).toEqual(homeJsonLd(description, "es")["@graph"] as Node[]);
    expect(one(nodes, "WebSite")).toMatchObject({
      "@id": siteUrl("/es#website"),
      url: siteUrl("/es"),
      inLanguage: "es-419",
    });
    expect(one(nodes, "WebApplication")).toMatchObject({
      url: siteUrl("/es"),
      inLanguage: "es-419",
      description,
      featureList: liveFeatureList("es"),
    });
    expect(liveFeatureList("es")).not.toEqual(liveFeatureList("en"));
    expect(one(nodes, "Organization")).toEqual(one(PAGES.home, "Organization"));
  });
});

describe("serializeJsonLd", () => {
  const hostile = { text: "</script><script>alert(1)</script><!-- \u2028\u2029 a/b" };

  test("leaves nothing that can close the script element or break a line", () => {
    const out = serializeJsonLd(hostile);
    for (const raw of ["<", ">", "/", "\u2028", "\u2029"]) expect(out).not.toContain(raw);
  });

  test("still parses to the same data", () => {
    expect(JSON.parse(serializeJsonLd(hostile))).toEqual(hostile);
  });

  test("is what JsonLd writes into the page", () => {
    const html = render(
      <JsonLd data={{ "@context": "https://schema.org", "@graph": [hostile as never] }} />
    ).container.innerHTML;
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\\u003c\\u002fscript\\u003e");
  });
});

describe("nodeText", () => {
  test("reads host elements and fragments, leaving screen-reader-only text out", () => {
    expect(
      nodeText(
        <>
          Yes.{" "}
          <a href="https://example.com">
            verify.ts<span className="sr-only"> (opens in a new tab)</span>
          </a>
          {["  a", 1, null, false]}
        </>
      )
    ).toBe("Yes. verify.ts a1");
  });

  test("refuses a component it cannot see into", () => {
    const Hidden = () => <span>hidden</span>;
    expect(() => nodeText(<Hidden />)).toThrow("host elements only");
  });
});
