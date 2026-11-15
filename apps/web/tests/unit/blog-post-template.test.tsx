import { afterEach, describe, expect, mock, test } from "bun:test";
import { within } from "@testing-library/react";
import PostDates from "@/components/blog/PostDates";
import PostNextStep, { DEFAULT_NEXT_STEP } from "@/components/blog/PostNextStep";
import RelatedPosts from "@/components/blog/RelatedPosts";
import ContentStatusTable from "@/components/blog/ContentStatusTable";
import { relatedPosts, type PostMeta } from "@/lib/blog";
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
    readingTime: "4 min read",
  };
}

describe("the post dates", () => {
  test("show the last-updated date only when the post changed after publishing", () => {
    const edited = renderMarketing(
      <PostDates post={{ ...meta("p", ["a"]), updatedAt: "2026-11-15" }} />
    );
    expect(edited.textContent).toContain("Updated November 15, 2026");
    expect(edited.querySelector('time[datetime="2026-11-15"]')).not.toBeNull();
    expect(edited.querySelector('time[datetime="2026-06-02"]')?.textContent).toBe("June 2, 2026");

    const unedited = renderMarketing(<PostDates post={meta("q", ["a"])} />);
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
        <PostNextStep />
        <RelatedPosts posts={relatedPosts(post, all)} />
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
    const root = renderMarketing(<PostNextStep lead="Check your trustlines now." />);
    expect(root.textContent).toContain("Check your trustlines now.");
    expect(root.textContent).not.toContain(DEFAULT_NEXT_STEP);
  });

  test("the related block is left out when no post shares a tag", () => {
    const root = renderMarketing(<RelatedPosts posts={[]} />);
    expect(root.innerHTML).toBe("");
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
