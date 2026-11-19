import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import HeroAccountInput from "@/components/marketing/HeroAccountInput";
import type { RecoveryEstimate } from "@/lib/api/estimate-client";
import { ADDRESS } from "@/lib/i18n/messages/address";
import { HERO } from "@/lib/i18n/messages/hero";

const VALID = Keypair.random().publicKey();
const CHECKSUM_TYPO = VALID.slice(0, -1) + (VALID.endsWith("A") ? "B" : "A");
const T = HERO.es;

const ESTIMATE: RecoveryEstimate = {
  readAt: "2026-11-07T12:34:00.000Z",
  range: {
    lowStroops: "124999400",
    highStroops: "201234567",
    feeStroops: "600",
    convertedAssets: 2,
    unquotedSwaps: 0,
    unconvertibleAssets: 0,
    leavesOutDefiExits: false,
    blockers: 1,
  },
};

let fetchSpy: ReturnType<typeof spyOn>;

function answer(status: number, body: unknown) {
  fetchSpy.mockImplementation((async () => Response.json(body, { status })) as never);
}

beforeEach(() => {
  spyOn(navigation, "useRouter").mockReturnValue({ push: mock(() => {}) } as never);
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => mock.restore());

async function estimateFor(value: string) {
  render(<HeroAccountInput locale="es" />);
  fireEvent.change(screen.getByRole("textbox", { name: T.input.label }), { target: { value } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: T.input.estimate }));
  });
}

test("an invalid address is refused in Spanish", async () => {
  await estimateFor(CHECKSUM_TYPO);
  expect(screen.getByRole("alert").textContent).toBe(ADDRESS.es.problems.checksum);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a pasted secret key is refused with the Spanish warning", () => {
  render(<HeroAccountInput locale="es" />);
  fireEvent.change(screen.getByRole("textbox", { name: T.input.label }), {
    target: { value: Keypair.random().secret() },
  });
  expect(screen.getByRole("alert").textContent).toBe(ADDRESS.es.problems["secret-key"]);
});

test("an estimate reads in Spanish, its figures written for es-419", async () => {
  answer(200, ESTIMATE);
  await estimateFor(VALID);
  expect(await screen.findByText("De 12.49 a 20.12 XLM")).toBeTruthy();
  expect(screen.getByText(T.estimate.caveat)).toBeTruthy();
  expect(screen.getByText(T.estimate.blockers(1))).toBeTruthy();
  expect(screen.getByRole("button", { name: T.estimate.continue })).toBeTruthy();
});

test("a failed estimate gives its reason in Spanish", async () => {
  answer(404, {});
  await estimateFor(VALID);
  expect(await screen.findAllByText(T.estimate.errors.missing)).toHaveLength(2);
});
