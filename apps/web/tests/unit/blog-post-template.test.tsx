import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { within } from "@testing-library/react";
import PostDates from "@/components/blog/PostDates";
import PostNextStep from "@/components/blog/PostNextStep";
import PostPage from "@/components/blog/PostPage";
import BlogIndexPage from "@/components/blog/BlogIndexPage";
import { getAllPostMetas, getPost } from "@/lib/blog";
import { BLOG } from "@/lib/i18n/messages/blog";
import { formatNumber } from "@/lib/i18n/format";
import { BASE_RESERVE_XLM } from "@/lib/site/reserve";
import RelatedPosts from "@/components/blog/RelatedPosts";
import ContentStatusTable from "@/components/blog/ContentStatusTable";
import { relatedPosts, type PostMeta } from "@/lib/blog";

const DEFAULT_NEXT_STEP = BLOG.en.post.nextStepLead;

/** A post page as the build prerenders it: the MDX body is an async server component. */
async function prerender(element: ReactElement): Promise<HTMLElement> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const root = document.createElement("div");
  root.innerHTML = await new Response(stream).text();
  return root;
}
import { contentStatusRows } from "@/lib/site/content-status";
import { renderMarketing } from "./fixtures/marketing";

afterEach(() => mock.restore());

function meta(slug: string, tags: string[], publishedAt = "2026-06-02"): PostMeta {
  return {
    slug,
    title: `Title of ${slug}`,
    description: `About ${slug}.`,
    publishedAt,
    updatedAt: publishedAt,
    category: "Guides",
    tags,
    readingMinutes: 4,
  };
}

describe("the post dates", () => {
  test("show the last-updated date only when the post changed after publishing", () => {
    const edited = renderMarketing(
      <PostDates post={{ ...meta("p", ["a"]), updatedAt: "2026-11-15" }} locale="en" />
    );
    expect(edited.textContent).toContain("Updated November 15, 2026");
    expect(edited.querySelector('time[datetime="2026-11-15"]')).not.toBeNull();
    expect(edited.querySelector('time[datetime="2026-06-02"]')?.textContent).toBe("June 2, 2026");

    const unedited = renderMarketing(<PostDates post={meta("q", ["a"])} locale="en" />);
    expect(unedited.textContent).not.toContain("Updated");
  });
});

describe("the end of a post", () => {
  test("relates the posts that share a tag with a two-tag post and calls to analyze an account", () => {
    const post = meta("two-tags", ["trustlines", "reserves"]);
    const all = [
      post,
      meta("shares-both", ["trustlines", "reserves"]),
      meta("shares-one", ["reserves"]),
      meta("shares-none", ["defi"]),
    ];
    const root = renderMarketing(
      <>
        <PostNextStep locale="en" />
        <RelatedPosts posts={relatedPosts(post, all)} locale="en" />
      </>
    );
    const related = within(root).getByRole("region", { name: "Related" });
    const links = within(related).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/blog/shares-both",
      "/blog/shares-one",
    ]);

    const next = within(root).getByRole("region", { name: "Next step" });
    expect(next.textContent).toContain(DEFAULT_NEXT_STEP);
    const action = within(next).getByRole("link", { name: "Analyze an account" });
    expect(action.getAttribute("href")).toBe("/mainnet");
    expect(action.className).toContain("bg-accent");
  });

  test("the next step carries the post's own lead when it has one", () => {
    const root = renderMarketing(<PostNextStep lead="Check your trustlines now." locale="en" />);
    expect(root.textContent).toContain("Check your trustlines now.");
    expect(root.textContent).not.toContain(DEFAULT_NEXT_STEP);
  });

  test("the related block is left out when no post shares a tag", () => {
    const root = renderMarketing(<RelatedPosts posts={[]} locale="en" />);
    expect(root.innerHTML).toBe("");
  });
});

describe("a post in Spanish", () => {
  test("dates it and counts its reading time as a Spanish reader writes them", () => {
    const root = renderMarketing(
      <PostDates post={{ ...meta("p", ["a"]), updatedAt: "2026-11-15" }} locale="es" />
    );
    expect(root.textContent).toContain("2 de junio de 2026");
    expect(root.textContent).toContain("Actualizado el 15 de noviembre de 2026");
    expect(root.textContent).toContain("4 min de lectura");
  });

  test("relates Spanish posts at their Spanish URLs and calls to analyze an account in Spanish", () => {
    const post = meta("self", ["trustlines"]);
    const root = renderMarketing(
      <>
        <PostNextStep locale="es" />
        <RelatedPosts
          posts={relatedPosts(post, [post, meta("other", ["trustlines"])])}
          locale="es"
        />
      </>
    );
    const related = within(root).getByRole("region", { name: "Relacionados" });
    expect(within(related).getByRole("link").getAttribute("href")).toBe("/es/blog/other");
    const next = within(root).getByRole("region", { name: "Siguiente paso" });
    expect(next.textContent).toContain(BLOG.es.post.nextStepLead);
    const action = within(next).getByRole("link", { name: "Analizar una cuenta" });
    expect(action.getAttribute("href")).toBe("/mainnet");
  });

  test("renders the translated post with its Spanish frame, figures and anchors", async () => {
    const { slug } = getAllPostMetas("es")[0]!;
    const post = getPost(slug, "es");
    const root = await prerender(PostPage({ locale: "es", slug }));
    expect(within(root).getByRole("heading", { level: 1 }).textContent).toBe(post.title);
    expect(
      within(root).getByRole("link", { name: "Todos los artículos" }).getAttribute("href")
    ).toBe("/es/blog");
    expect(root.textContent).toContain(post.cta!);
    expect(root.textContent).toContain("Guías");
    expect(root.textContent).toContain(BLOG.es.readingTime(post.readingMinutes));
    expect(root.textContent).not.toContain("min read");
    expect(root.querySelector('time[datetime="2026-11-15"]')?.textContent).toBe(
      "15 de noviembre de 2026"
    );
    expect(root.textContent).toContain(`${formatNumber("es", BASE_RESERVE_XLM)} XLM por entrada`);
    const ids = [...root.querySelectorAll("h2[id]")].map((h) => h.id);
    expect(ids).toContain("que-es-una-trustline");
  });
});

describe("the blog index", () => {
  test("in Spanish, lists only the Spanish posts, linked at their Spanish URLs", () => {
    const root = renderMarketing(<BlogIndexPage locale="es" />);
    expect(within(root).getByRole("heading", { level: 1 }).textContent).toBe(BLOG.es.heading);
    const hrefs = within(root)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(getAllPostMetas("es").map((p) => `/es/blog/${p.slug}`));
  });

  test("in English, lists the English posts as before", () => {
    const root = renderMarketing(<BlogIndexPage locale="en" />);
    const hrefs = within(root)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(getAllPostMetas().map((p) => `/blog/${p.slug}`));
  });
});

describe("the content status table", () => {
  test("lists published posts with their link and date, then the planned articles", () => {
    const rows = contentStatusRows([meta("out", ["a"])], [{ slug: "next", title: "Next one" }]);
    const root = renderMarketing(<ContentStatusTable rows={rows} />);
    const [, published, planned] = within(root).getAllByRole("row");
    expect(
      within(published!).getByRole("link", { name: "Title of out" }).getAttribute("href")
    ).toBe("/blog/out");
    expect(published!.textContent).toContain("Published");
    expect(published!.textContent).toContain("June 2, 2026");
    expect(within(planned!).queryByRole("link")).toBeNull();
    expect(planned!.textContent).toContain("Planned");
    expect(planned!.textContent).toContain("Not yet");
  });

  test("fails when a planned article is already published", () => {
    expect(() =>
      contentStatusRows([meta("next", ["a"])], [{ slug: "next", title: "Next one" }])
    ).toThrow('Planned article "next" is already published');
  });
});
