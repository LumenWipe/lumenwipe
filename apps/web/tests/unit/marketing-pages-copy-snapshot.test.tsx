import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as navigation from "next/navigation";
import type { Metadata } from "next";
import StatsPage, { metadata as statsMetadata } from "@/app/(marketing)/stats/page";
import RegistryPage, { metadata as registryMetadata } from "@/app/(marketing)/registry/page";
import PlaygroundPage, { metadata as playgroundMetadata } from "@/app/(marketing)/playground/page";
import ContentPage, { metadata as contentMetadata } from "@/app/(marketing)/content/page";
import BlogPage, { metadata as blogMetadata } from "@/app/(marketing)/blog/page";
import CalendarHeatmap from "@/components/marketing/stats/CalendarHeatmap";
import ConstellationChart from "@/components/marketing/stats/ConstellationChart";
import DistributionStrip from "@/components/marketing/stats/DistributionStrip";
import RecentFeed from "@/components/marketing/stats/RecentFeed";
import StatsHero from "@/components/marketing/stats/StatsHero";
import StatsClient from "@/components/marketing/stats/StatsClient";
import RegistryClient from "@/components/marketing/registry/RegistryClient";
import CategoryBadge from "@/components/blog/CategoryBadge";
import PostDates from "@/components/blog/PostDates";
import * as blog from "@/lib/blog";
import { bundledRegistry, type RegistrySnapshot } from "@/lib/exchange-registry";
import { PROTOCOLS_VERIFIED } from "@/lib/site/status";
import type { FeedData } from "@/hooks/useFeed";
import { fakeRouter } from "./fixtures/navigation";

// Recorded from the English copy of the stats, registry, playground and content pages and the blog
// index as it stood before it moved into the locale dictionary. A change here is a change to what
// an English reader sees, so it is never updated alongside a refactor. The pages are
// server-rendered, as the build prerenders them; the states that exist only in the browser (a
// loaded feed, a hovered day, the registry's verdicts) are rendered after mount. The clock is
// pinned.

const NOW = "2026-11-16T00:00:00Z";

const STROOPS = (xlm: number) => String(Math.round(xlm * 10_000_000));

function close(hash: string, timestamp: string, xlm: number): FeedData["recent"][number] {
  return {
    txHash: hash.repeat(64),
    network: "mainnet",
    accountsClosed: 1,
    xlmStroops: STROOPS(xlm),
    timestamp,
  };
}

const FEED: FeedData = {
  recent: [
    close("a", "2026-11-15T23:59:30.000Z", 1.5),
    close("b", "2026-11-15T23:30:00.000Z", 45),
    close("c", "2026-11-15T20:00:00.000Z", 3),
    close("d", "2026-11-15T10:00:01.000Z", 2),
    close("e", "2026-11-15T10:00:02.000Z", 2),
    close("f", "2026-11-15T10:00:03.000Z", 2),
    close("g", "2026-11-15T10:00:04.000Z", 2),
    close("h", "2026-11-14T10:00:00.000Z", 7),
    close("i", "2026-11-10T12:00:00.000Z", 1234.5),
  ],
  daily: [
    { date: "2026-11-10", count: 1 },
    { date: "2026-11-14", count: 1 },
    { date: "2026-11-15", count: 7 },
  ],
  totals: {
    testnet: 1234,
    mainnet: 9,
    testnetXlmStroops: "0",
    mainnetXlmStroops: STROOPS(1299),
  },
};

const EMPTY: FeedData = {
  recent: [],
  daily: [],
  totals: { testnet: 0, mainnet: 0, testnetXlmStroops: "0", mainnetXlmStroops: "0" },
};

const PAGES: Record<string, () => ReactElement> = {
  stats: () => <StatsPage />,
  registry: () => <RegistryPage />,
  playground: () => <PlaygroundPage />,
  content: () => <ContentPage />,
  blog: () => <BlogPage />,
};

const METADATA: Record<string, Metadata> = {
  stats: statsMetadata,
  registry: registryMetadata,
  playground: playgroundMetadata,
  content: contentMetadata,
  blog: blogMetadata,
};

function serverRender(element: ReactElement): string {
  spyOn(navigation, "useRouter").mockReturnValue(fakeRouter());
  spyOn(navigation, "usePathname").mockReturnValue("/");
  return renderToString(element);
}

async function mounted(element: ReactElement): Promise<HTMLElement> {
  const { container } = render(element);
  await act(async () => {});
  return container;
}

beforeAll(() => setSystemTime(new Date(NOW)));
afterAll(() => setSystemTime());
afterEach(() => {
  cleanup();
  mock.restore();
});

describe("English copy of the stats, registry, playground and content pages and the blog index", () => {
  for (const [name, page] of Object.entries(PAGES)) {
    test(`${name} renders the recorded markup`, () => {
      expect(serverRender(page())).toMatchSnapshot();
    });
  }

  for (const [name, metadata] of Object.entries(METADATA)) {
    test(`${name} metadata is the recorded metadata`, () => {
      expect(JSON.parse(JSON.stringify(metadata))).toMatchSnapshot();
    });
  }

  test("the blog index and the content page with no post published", () => {
    spyOn(blog, "getAllPostMetas").mockReturnValue([]);
    expect(serverRender(<BlogPage />)).toMatchSnapshot();
    expect(serverRender(<ContentPage />)).toMatchSnapshot();
  });

  test("each category badge and a post's dates once it was updated", () => {
    expect(
      blog.CATEGORIES.map((category) =>
        renderToString(<CategoryBadge category={category} locale="en" />)
      )
    ).toMatchSnapshot();
    expect(
      renderToString(
        <PostDates
          post={{
            ...blog.getAllPostMetas()[0],
            publishedAt: "2026-11-01",
            updatedAt: "2026-11-15",
          }}
          locale="en"
        />
      )
    ).toMatchSnapshot();
  });
});

describe("English copy of the stats components", () => {
  for (const [state, feed] of [
    ["with closes", FEED],
    ["empty", EMPTY],
  ] as const) {
    test(`the hero, ${state}, server-rendered`, () => {
      expect(renderToString(<StatsHero feed={feed} />)).toMatchSnapshot();
    });

    for (const [name, Component] of [
      ["the heatmap", CalendarHeatmap],
      ["the chart", ConstellationChart],
      ["the strip", DistributionStrip],
      ["the feed", RecentFeed],
    ] as const) {
      test(`${name}, ${state}, after mount`, async () => {
        expect((await mounted(<Component feed={feed} />)).innerHTML).toMatchSnapshot();
      });
    }
  }

  test("the heatmap's detail panel for each day hovered", async () => {
    const container = await mounted(<CalendarHeatmap feed={FEED} />);
    const panel = container.firstElementChild!.children[2];
    const shown = new Set<string>([panel.innerHTML]);
    for (const cell of container.querySelectorAll("[role=region] .cursor-default")) {
      fireEvent.mouseEnter(cell);
      shown.add(panel.innerHTML);
    }
    expect([...shown]).toMatchSnapshot();
  });

  for (const [name, Component, dot] of [
    ["the chart", ConstellationChart, "circle[fill^='hsl']"],
    ["the strip", DistributionStrip, "circle[filter='url(#dot-glow)']"],
  ] as const) {
    test(`${name}'s tooltip for a hovered close`, async () => {
      const container = await mounted(<Component feed={FEED} />);
      const dots = container.querySelectorAll(dot);
      expect(dots.length).toBeGreaterThan(0);
      fireEvent.mouseEnter(dots[dots.length - 1]);
      expect(container.innerHTML).toMatchSnapshot();
    });
  }

  test("the stale-data notice when the feed cannot be read", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const container = await mounted(<StatsClient />);
    expect(container.querySelector(".text-warning\\/70")?.outerHTML).toMatchSnapshot();
  });
});

describe("English copy of the registry's states", () => {
  const BUNDLED = bundledRegistry();
  const at = (iso: string) => () => new Date(iso);
  const after = (date: string) => () => new Date(Date.parse(`${date}T23:59:59Z`) + 1000);
  const added = { ...BUNDLED.entries[0], address: `G${"Q".repeat(55)}` };
  const served = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot => ({
    ...BUNDLED,
    served: true,
    lastVerified: "2026-11-01",
    entries: [...BUNDLED.entries, added],
    memoTypeDisputes: [BUNDLED.entries[0].address],
    ...over,
  });

  test("while the API's copy is read", async () => {
    const pending = new Promise<RegistrySnapshot | null>(() => {});
    const container = await mounted(<RegistryClient load={() => pending} clock={at(NOW)} />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  test("when the API's copy cannot be read", async () => {
    const container = await mounted(<RegistryClient load={async () => null} clock={at(NOW)} />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  test("with the API's copy, an added exchange and a disputed memo type", async () => {
    const container = await mounted(<RegistryClient load={async () => served()} clock={at(NOW)} />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  test("past both lists' last day", async () => {
    const until = [PROTOCOLS_VERIFIED.validUntil, "2026-12-01"].sort().at(-1)!;
    const container = await mounted(
      <RegistryClient
        load={async () => served({ validUntil: "2026-12-01" })}
        clock={after(until)}
      />
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
});
