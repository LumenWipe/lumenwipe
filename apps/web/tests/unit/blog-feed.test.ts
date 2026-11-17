import { describe, expect, test } from "bun:test";
import type { Metadata } from "next";
import { GET, dynamic } from "@/app/(marketing)/blog/feed.xml/route";
import { metadata as blogMetadata } from "@/app/(marketing)/blog/page";
import { generateMetadata as postMetadata } from "@/app/(marketing)/blog/[slug]/page";
import robots from "@/app/robots";
import { getAllPostMetas, type PostMeta } from "@/lib/blog";
import { blogFeed, escapeXml } from "@/lib/blog-feed";
import { BLOG_DESCRIPTION, BLOG_FEED } from "@/lib/site/pages";
import { siteUrl } from "@/lib/site/url";

/** The parsed feed, failing on anything that is not well-formed XML. happy-dom's parser catches
 *  broken nesting but forgives a bare `&` or `<` in text, so those are checked on the source. */
function parseFeed(xml: string): Document {
  expect(xml.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i)).toBeNull();
  expect(xml.match(/<(?![?!/a-zA-Z])/)).toBeNull();
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  expect(doc.documentElement.tagName).toBe("rss");
  return doc;
}

function items(doc: Document): Array<Record<string, string>> {
  return [...doc.getElementsByTagName("item")].map((item) =>
    Object.fromEntries(
      ["title", "link", "guid", "pubDate", "description"].map((name) => [
        name,
        item.getElementsByTagName(name)[0]?.textContent ?? "",
      ])
    )
  );
}

function post(overrides: Partial<PostMeta>): PostMeta {
  return {
    slug: "a-post",
    title: "A post",
    description: "About a post.",
    publishedAt: "2026-11-01",
    updatedAt: "2026-11-01",
    category: "Guides",
    tags: ["stellar"],
    readingTime: "1 min read",
    ...overrides,
  };
}

function feedLinks(metadata: Metadata): unknown {
  return metadata.alternates?.types?.[BLOG_FEED.type];
}

const FEED_LINK = [{ url: siteUrl(BLOG_FEED.path), title: BLOG_FEED.title }];

describe("the blog feed", () => {
  test("escapes every XML special character and drops characters XML cannot carry", () => {
    expect(escapeXml(`R&D <b> "x" 'y'`)).toBe("R&amp;D &lt;b&gt; &quot;x&quot; &apos;y&apos;");
    expect(escapeXml("a\u0000b\u0007c\td")).toBe("abc\td");
    expect(escapeXml("a\uFFFEb\uD800c")).toBe("abc");
  });

  test("keeps hostile post metadata as text, so the feed stays well formed", () => {
    const hostile = `R&D <script>alert("x")</script> 'quoted' ]]>`;
    const doc = parseFeed(blogFeed([post({ title: hostile, description: hostile })]));
    expect(doc.getElementsByTagName("script")).toHaveLength(0);
    expect(items(doc)[0]).toMatchObject({ title: hostile, description: hostile });
  });

  test("lists each post with its link, date and description, in the order given", () => {
    const doc = parseFeed(
      blogFeed([
        post({ slug: "newer", publishedAt: "2026-11-05", title: "Newer", description: "New." }),
        post({ slug: "older", publishedAt: "2026-10-01", updatedAt: "2026-11-10" }),
      ])
    );
    expect(items(doc)).toEqual([
      {
        title: "Newer",
        link: siteUrl("/blog/newer"),
        guid: siteUrl("/blog/newer"),
        pubDate: "Thu, 05 Nov 2026 00:00:00 GMT",
        description: "New.",
      },
      {
        title: "A post",
        link: siteUrl("/blog/older"),
        guid: siteUrl("/blog/older"),
        pubDate: "Thu, 01 Oct 2026 00:00:00 GMT",
        description: "About a post.",
      },
    ]);
    expect(doc.getElementsByTagName("lastBuildDate")[0]?.textContent).toBe(
      "Tue, 10 Nov 2026 00:00:00 GMT"
    );
  });

  test("an empty blog is still a valid feed", () => {
    const doc = parseFeed(blogFeed([]));
    expect(doc.getElementsByTagName("item")).toHaveLength(0);
    expect(doc.getElementsByTagName("lastBuildDate")).toHaveLength(0);
  });

  test("is prerendered and served as RSS with every published post, newest first", async () => {
    expect(dynamic).toBe("force-static");
    const response = GET();
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    const doc = parseFeed(await response.text());

    const channel = doc.getElementsByTagName("channel")[0]!;
    expect(channel.getElementsByTagName("title")[0]?.textContent).toBe(BLOG_FEED.title);
    expect(channel.getElementsByTagName("link")[0]?.textContent).toBe(siteUrl("/blog"));
    expect(channel.getElementsByTagName("description")[0]?.textContent).toBe(BLOG_DESCRIPTION);
    expect(doc.getElementsByTagName("atom:link")[0]?.getAttribute("href")).toBe(
      siteUrl(BLOG_FEED.path)
    );

    const posts = getAllPostMetas();
    expect(posts.length).toBeGreaterThan(0);
    expect(items(doc).map((item) => item.link)).toEqual(
      posts.map((p) => siteUrl(`/blog/${p.slug}`))
    );
    expect(items(doc).map((item) => item.title)).toEqual(posts.map((p) => p.title));
    const dates = posts.map((p) => p.publishedAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test("the blog index and every post link the feed", async () => {
    expect(feedLinks(blogMetadata)).toEqual(FEED_LINK);
    for (const { slug } of getAllPostMetas()) {
      const metadata = await postMetadata({ params: Promise.resolve({ slug }) });
      expect({ slug, link: feedLinks(metadata) }).toEqual({ slug, link: FEED_LINK });
    }
  });

  test("robots does not keep crawlers off the feed", () => {
    const rules = [robots().rules].flat();
    for (const rule of rules) {
      const disallowed = [rule.disallow ?? []].flat();
      expect(disallowed.some((path) => BLOG_FEED.path.startsWith(path))).toBe(false);
    }
  });
});
