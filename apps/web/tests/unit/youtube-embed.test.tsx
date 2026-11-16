import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import YouTubeEmbed from "@/components/blog/YouTubeEmbed";
import { VIDEOS, videoPoster, YOUTUBE_EMBED_ORIGIN } from "@/lib/site/videos";
import { expectFocused } from "./fixtures/focus";

const WEB_ROOT = join(import.meta.dir, "..", "..");
const BLOG_DIR = join(WEB_ROOT, "content", "blog");

afterEach(cleanup);

function postVideoIds(): string[] {
  return readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".mdx"))
    .flatMap((f) =>
      [...readFileSync(join(BLOG_DIR, f), "utf8").matchAll(/<YouTubeEmbed\s+id="([^"]+)"/g)].map(
        (m) => m[1]
      )
    );
}

test("before a click the embed is a named button over a local poster, with no player", () => {
  const { container } = render(<YouTubeEmbed id="vD3xhPpqah8" title="What is LumenWipe?" />);
  const button = screen.getByRole("button", { name: "Play video: What is LumenWipe?" });
  expect(container.querySelector("iframe")).toBeNull();
  const poster = button.querySelector("img");
  expect(poster?.getAttribute("src")).toBe("/video-posters/vD3xhPpqah8.webp");
  expect(poster?.getAttribute("alt")).toBe("");
  expect(container.innerHTML).not.toMatch(/youtube|ytimg/i);
});

test("pressing play loads the privacy-enhanced player, titled, and moves focus into it", async () => {
  render(<YouTubeEmbed id="vD3xhPpqah8" title="What is LumenWipe?" />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Play video:/ }));
  });
  expect(screen.queryByRole("button", { name: /^Play video:/ })).toBeNull();
  const frame = screen.getByTitle("What is LumenWipe?");
  expect(frame.tagName).toBe("IFRAME");
  expect(new URL(frame.getAttribute("src") ?? "").origin).toBe(YOUTUBE_EMBED_ORIGIN);
  await expectFocused(frame);
});

test("every video on the content page and in a post has its poster in public/", () => {
  const ids = [...VIDEOS.map((v) => v.id), ...postVideoIds()];
  expect(postVideoIds().length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(existsSync(join(WEB_ROOT, "public", videoPoster(id))), id).toBe(true);
  }
});
