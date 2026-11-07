import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import HeroAccountInput from "@/components/marketing/HeroAccountInput";
import { formatXlmDown, type RecoveryEstimate } from "@/lib/api/estimate-client";
import { CLAIM_PATTERNS } from "@/lib/journey/claims";

const VALID = Keypair.random().publicKey();
const CHECKSUM_TYPO = VALID.slice(0, -1) + (VALID.endsWith("A") ? "B" : "A");
const CAVEAT = "Estimate, not a promise: fees and market quotes change";
const READ_AT = "2026-11-07T12:34:00.000Z";

function estimate(over: Partial<RecoveryEstimate["range"]> = {}): RecoveryEstimate {
  return {
    readAt: READ_AT,
    range: {
      lowStroops: "124999400",
      highStroops: "201234567",
      feeStroops: "600",
      convertedAssets: 2,
      unquotedSwaps: 0,
      tokenSwaps: 0,
      unconvertibleAssets: 0,
      leavesOutDefiExits: false,
      blockers: 0,
      ...over,
    },
  };
}

let push: ReturnType<typeof mock>;
let fetchSpy: ReturnType<typeof spyOn>;
let stored: ReturnType<typeof spyOn>;

function answer(status: number, body: unknown) {
  fetchSpy.mockImplementation((async () => Response.json(body, { status })) as never);
}

beforeEach(() => {
  push = mock(() => {});
  spyOn(navigation, "useRouter").mockReturnValue({ push } as never);
  fetchSpy = spyOn(globalThis, "fetch");
  answer(200, estimate());
  stored = spyOn(Storage.prototype, "setItem");
});

afterEach(() => mock.restore());

function type(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Stellar account address" }), {
    target: { value },
  });
}

async function estimateFor(value: string) {
  render(<HeroAccountInput />);
  type(value);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Estimate recovery" }));
  });
}

test("the primary action still goes to the analyze route and asks for no estimate", () => {
  render(<HeroAccountInput />);
  type(VALID);
  fireEvent.click(screen.getByRole("button", { name: "Analyze account" }));
  expect(push).toHaveBeenCalledWith(`/mainnet/analyze?source=${VALID}`);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("an invalid address shows the app form's message and asks for nothing", async () => {
  await estimateFor(CHECKSUM_TYPO);
  expect(screen.getByRole("alert").textContent).toContain("checksum");
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

test("an estimate shows the range, the read time, the caveat and the blockers, without navigating", async () => {
  await estimateFor(VALID);
  expect(await screen.findByText("12.49 to 20.12 XLM")).toBeTruthy();
  expect(screen.getByText(CAVEAT)).toBeTruthy();
  expect(document.querySelector(`time[datetime="${READ_AT}"]`)).not.toBeNull();
  expect(screen.getByText("No items found that would block a close.")).toBeTruthy();
  expect(push).not.toHaveBeenCalled();
});

test("the address goes in a POST body, never in a URL, and nothing is stored", async () => {
  await estimateFor(VALID);
  await screen.findByText(CAVEAT);
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/mainnet/estimate");
  expect(url).not.toContain(VALID);
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ address: VALID });
  expect(window.location.href).not.toContain(VALID);
  expect(stored).not.toHaveBeenCalled();
});

test("the result is announced through a polite live region", async () => {
  await estimateFor(VALID);
  const region = screen.getByRole("status");
  expect(region.getAttribute("aria-live")).toBe("polite");
  await waitFor(() => expect(region.textContent).toContain("12.49 to 20.12 XLM"));
  expect(region.textContent).toContain(CAVEAT);
});

test("a blocked account names its blockers and the assumptions that apply", async () => {
  answer(
    200,
    estimate({ blockers: 2, unquotedSwaps: 1, unconvertibleAssets: 1, leavesOutDefiExits: true })
  );
  await estimateFor(VALID);
  expect(await screen.findByText("2 items would block a close until resolved.")).toBeTruthy();
  expect(screen.getByText("1 asset had no quote and count as zero.")).toBeTruthy();
  expect(screen.getByText("1 asset has no route to XLM and is not counted.")).toBeTruthy();
  expect(screen.getByText("XLM paid out by exiting DeFi positions is not counted.")).toBeTruthy();
});

test("with nothing to convert one figure is shown, still as an estimate", async () => {
  answer(200, estimate({ highStroops: "124999400", convertedAssets: 0 }));
  await estimateFor(VALID);
  expect(await screen.findByText("About 12.49 XLM")).toBeTruthy();
  expect(screen.getByText(CAVEAT)).toBeTruthy();
});

test.each([
  [404, "No account with this address exists"],
  [429, "Too many estimates"],
  [503, "We couldn't read this account right now"],
])("a failed read (%i) is a plain message, never a zero", async (status, text) => {
  answer(status, { error: { code: "x", message: `upstream ${VALID}` } });
  await estimateFor(VALID);
  const panel = await screen.findByRole("region", { name: "Recovery estimate" });
  const message = await within(panel).findByText(new RegExp(text));
  expect(message.textContent).not.toContain(VALID);
  expect(panel.textContent).not.toMatch(/\d XLM/);
  expect(screen.queryByText(CAVEAT)).toBeNull();
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(new RegExp(text)));
});

test("a network failure is the same plain message", async () => {
  fetchSpy.mockImplementation((async () => {
    throw new TypeError("Failed to fetch");
  }) as never);
  await estimateFor(VALID);
  const panel = await screen.findByRole("region", { name: "Recovery estimate" });
  expect(await within(panel).findByText(/We couldn't read this account right now/)).toBeTruthy();
});

test("continue to close takes the estimated address to the analyze route", async () => {
  await estimateFor(VALID);
  fireEvent.click(await screen.findByRole("button", { name: "Continue to close" }));
  expect(push).toHaveBeenCalledWith(`/mainnet/analyze?source=${VALID}`);
});

test("editing the address drops the estimate of the old one", async () => {
  await estimateFor(VALID);
  await screen.findByText(CAVEAT);
  type(VALID.slice(0, -1));
  expect(screen.queryByText(CAVEAT)).toBeNull();
});

test("no sentence of the estimate makes a claim about a close", async () => {
  answer(
    200,
    estimate({
      blockers: 1,
      unquotedSwaps: 2,
      unconvertibleAssets: 2,
      tokenSwaps: 1,
      leavesOutDefiExits: true,
    })
  );
  await estimateFor(VALID);
  await screen.findByText(CAVEAT);
  const text = document.body.textContent ?? "";
  for (const [claim, pattern] of Object.entries(CLAIM_PATTERNS)) {
    expect({ claim, matches: pattern.test(text) }).toEqual({ claim, matches: false });
  }
});

test("figures round down to two decimals", () => {
  expect(formatXlmDown("0")).toBe("0.00");
  expect(formatXlmDown("19999999")).toBe("1.99");
  expect(formatXlmDown("12345678900000")).toBe("1,234,567.89");
});
