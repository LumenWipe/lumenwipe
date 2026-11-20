import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import StatusBanner from "@/components/layout/StatusBanner";
import StatusBannerSlot from "@/components/layout/StatusBannerSlot";
import { fakeFetch } from "./fixtures/fetch";
import { ALL_OPERATIONAL, RPC_DEGRADED, WITH_EXTRAS } from "./fixtures/status/summaries";

const PAGE = "https://status.example.test";

type Answer = () => Response | Promise<Response>;

let answers: Answer[];
let calls: number;
let poll: (() => void) | undefined;

function report(summary: object, page: string = PAGE): Answer {
  return () => Response.json({ ...summary, page });
}

const NOTHING: Answer = () => new Response(null, { status: 204 });
const UNREACHABLE: Answer = () => {
  throw new TypeError("Failed to fetch");
};

/** Renders the banner and waits until it has read `/api/status` once. */
async function renderBanner(locale: "en" | "es" = "en"): Promise<HTMLElement> {
  const { container } = render(<StatusBanner locale={locale} />);
  await waitFor(() => expect(calls).toBe(1));
  await act(async () => {});
  return container;
}

/** Runs the next poll and waits for it to settle. */
async function nextPoll(): Promise<void> {
  const before = calls;
  await act(async () => poll!());
  await waitFor(() => expect(calls).toBe(before + 1));
  await act(async () => {});
}

beforeEach(() => {
  answers = [];
  calls = 0;
  poll = undefined;
  spyOn(globalThis, "fetch").mockImplementation(
    fakeFetch((url) => {
      expect(url).toBe("/api/status");
      const next = answers[Math.min(calls, answers.length - 1)]!;
      calls++;
      return next();
    })
  );
  const realSetInterval = globalThis.setInterval;
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms?: number) => {
    if (ms !== 60_000) return realSetInterval(callback, ms);
    poll = callback;
    return 0;
  }) as never);
});

afterEach(() => {
  cleanup();
  mock.restore();
});

test("status banner › a degraded component is named, with a link to the status page", async () => {
  answers = [report(RPC_DEGRADED)];
  await renderBanner();
  const banner = screen.getByRole("status", { name: "Service status" });
  expect(banner.textContent).toContain("Stellar RPC (mainnet): degraded");
  expect(banner.textContent).toContain("Horizon (testnet): outage");
  expect(banner.textContent).not.toContain("API");
  expect(screen.getByRole("link", { name: "Status page" }).getAttribute("href")).toBe(PAGE);
});

test("status banner › it disappears when the status host becomes unreachable", async () => {
  answers = [report(RPC_DEGRADED), UNREACHABLE];
  await renderBanner();
  expect(screen.queryByRole("status")).not.toBeNull();
  await nextPoll();
  expect(screen.queryByRole("status")).toBeNull();
});

test("status banner › it disappears when the route has nothing to show", async () => {
  answers = [report(RPC_DEGRADED), NOTHING];
  await renderBanner();
  await nextPoll();
  expect(screen.queryByRole("status")).toBeNull();
});

test.each([
  ["every component is operational", report(ALL_OPERATIONAL)],
  ["the route has nothing to show", NOTHING],
  ["the host is unreachable", UNREACHABLE],
  ["the route fails", () => new Response("", { status: 500 })],
  ["the body is not a summary", () => Response.json({ components: "api", page: PAGE })],
  ["the status page is not https", report(RPC_DEGRADED, "http://status.example.test")],
  ["the status page is missing", () => Response.json(RPC_DEGRADED)],
])("status banner › nothing renders when %s, never an all-clear", async (_, answer) => {
  answers = [answer];
  const container = await renderBanner();
  expect(container.innerHTML).toBe("");
});

test("status banner › no uptime figure and no component outside the close flow is shown", async () => {
  answers = [report(WITH_EXTRAS)];
  const container = await renderBanner();
  const text = container.textContent ?? "";
  expect(text).toContain("API: degraded");
  expect(text).not.toMatch(/%|99\.98|Docs|Playground|Totally|operational|all clear/i);
  expect(container.querySelector('a[href="https://x.test"]')).toBeNull();
});

test("status banner › the Spanish site gets Spanish copy", async () => {
  answers = [report(RPC_DEGRADED)];
  await renderBanner("es");
  const banner = screen.getByRole("status", { name: "Estado del servicio" });
  expect(banner.textContent).toContain("Horizon (testnet): caída");
  expect(screen.getByRole("link", { name: "Página de estado" })).not.toBeNull();
});

test.each([
  ["unset", undefined],
  ["plain http", "http://status.example.test/summary.json"],
  ["not a URL", "status.example.test"],
])("status banner › it is not mounted while the source is %s", (_, value) => {
  const saved = process.env.STATUS_SOURCE_URL;
  if (value === undefined) delete process.env.STATUS_SOURCE_URL;
  else process.env.STATUS_SOURCE_URL = value;
  try {
    expect(StatusBannerSlot({ locale: "en" })).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.STATUS_SOURCE_URL;
    else process.env.STATUS_SOURCE_URL = saved;
  }
});

test("status banner › it is mounted, in the page's locale, once an https source is set", () => {
  const saved = process.env.STATUS_SOURCE_URL;
  process.env.STATUS_SOURCE_URL = "https://status.example.test/summary.json";
  try {
    const slot = StatusBannerSlot({ locale: "es" });
    expect(slot?.type).toBe(StatusBanner);
    expect(slot?.props).toEqual({ locale: "es" });
  } finally {
    if (saved === undefined) delete process.env.STATUS_SOURCE_URL;
    else process.env.STATUS_SOURCE_URL = saved;
  }
});
