import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Suspense } from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as navigation from "next/navigation";
import NetworkLayout from "@/app/[network]/layout";
import RiskDisclaimerModal from "@/components/RiskDisclaimerModal";
import * as statsHook from "@/hooks/useStats";
import { expectNotFocused } from "./fixtures/focus";

const KEY = "lumenwipe_risk_accepted";
const HEADING = "Beta Software - Use at Your Own Risk";
const ACCEPT = { name: "I understand, continue" };

function gate() {
  return render(
    <RiskDisclaimerModal>
      <button>Behind</button>
    </RiskDisclaimerModal>
  );
}

function behind(): HTMLElement {
  return screen.getByText("Behind").parentElement as HTMLElement;
}

function replaceStorage(descriptor: PropertyDescriptor): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  Object.defineProperty(window, "sessionStorage", { configurable: true, ...descriptor });
  return () => Object.defineProperty(window, "sessionStorage", original as PropertyDescriptor);
}

function denied(): never {
  throw new DOMException("denied", "SecurityError");
}

function throwingStorage(): () => void {
  return replaceStorage({ get: denied });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  mock.restore();
});

test("RiskDisclaimerModal › the server sends the app inert and paints no notice", () => {
  const html = renderToString(
    <RiskDisclaimerModal>
      <button>Behind</button>
    </RiskDisclaimerModal>
  );
  expect(html).toMatch(/<div[^>]*\binert=""[^>]*><button>Behind/);
  expect(html).not.toContain("Beta Software");
  expect(html).not.toContain("dialog");
});

test("RiskDisclaimerModal › shows the gate and keeps the app inert until accepted", () => {
  gate();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("heading", { name: HEADING })).toBeTruthy();
  expect(behind().hasAttribute("inert")).toBe(true);
});

test("RiskDisclaimerModal › accepting through the button records it and frees the app", () => {
  gate();
  fireEvent.click(screen.getByRole("button", ACCEPT));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(behind().hasAttribute("inert")).toBe(false);
  expect(window.sessionStorage.getItem(KEY)).toBe("1");
});

test("RiskDisclaimerModal › an earlier acceptance shows nothing", () => {
  window.sessionStorage.setItem(KEY, "1");
  gate();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(behind().hasAttribute("inert")).toBe(false);
});

test("RiskDisclaimerModal › Escape and the scrim do not dismiss it", () => {
  gate();
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  fireEvent.click(document.querySelector("[data-dialog-scrim]") as Element);
  expect(screen.queryByRole("dialog")).not.toBeNull();
  expect(window.sessionStorage.getItem(KEY)).toBeNull();
});

test("RiskDisclaimerModal › opening focus lands on the text, not the accept button", () => {
  gate();
  const button = screen.getByRole("button", ACCEPT);
  expectNotFocused(button);
  expect(document.activeElement?.textContent).toContain("permanent and irreversible");
});

test("RiskDisclaimerModal › the copy reads as written", () => {
  gate();
  const text = screen.getByRole("dialog").textContent;
  for (const line of [
    "LumenWipe is under active development",
    "Closing a Stellar account is permanent and irreversible - always verify your destination address before signing. Bugs may still exist; use at your own risk.",
    "Account merge (direct and via exchange relay account)",
    "Claimable balance claiming",
    "Anything that cannot be exited blocks the close by name until you handle it yourself.",
    "This notice appears once per browser session.",
  ]) {
    expect(text).toContain(line);
  }
});

test("RiskDisclaimerModal › a throwing getItem fails closed", () => {
  const restore = replaceStorage({ value: { getItem: denied, setItem: () => {} } });
  try {
    gate();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(behind().hasAttribute("inert")).toBe(true);
  } finally {
    restore();
  }
});

test("RiskDisclaimerModal › a stored acceptance that cannot be read still gates", () => {
  window.sessionStorage.setItem(KEY, "1");
  const restore = throwingStorage();
  try {
    gate();
    expect(screen.getByRole("dialog")).toBeTruthy();
  } finally {
    restore();
  }
});

test("RiskDisclaimerModal › with no storage at all the button still frees the app", () => {
  const restore = throwingStorage();
  try {
    gate();
    fireEvent.click(screen.getByRole("button", ACCEPT));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(behind().hasAttribute("inert")).toBe(false);
  } finally {
    restore();
  }
});

test("RiskDisclaimerModal › a throwing setItem does not trap the user", () => {
  const restore = replaceStorage({ value: { getItem: () => null, setItem: denied } });
  try {
    gate();
    fireEvent.click(screen.getByRole("button", ACCEPT));
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    restore();
  }
});

test("NetworkLayout › with a throwing sessionStorage the layout renders and the gate shows", async () => {
  spyOn(navigation, "useRouter").mockReturnValue({ push: () => {}, replace: () => {} } as never);
  spyOn(navigation, "usePathname").mockReturnValue("/testnet");
  spyOn(navigation, "useSearchParams").mockReturnValue(new URLSearchParams() as never);
  spyOn(statsHook, "useStats").mockReturnValue({ data: null } as never);
  const params = Object.assign(Promise.resolve({ network: "testnet" }), {
    status: "fulfilled",
    value: { network: "testnet" },
  });
  const restore = throwingStorage();
  try {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <NetworkLayout params={params}>
            <button>Page</button>
          </NetworkLayout>
        </Suspense>
      );
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: HEADING })).toBeTruthy();
    expect(screen.getByText("Page").closest("[inert]")).not.toBeNull();
    expect(screen.getByText("Page").closest("main")).not.toBeNull();
  } finally {
    restore();
  }
});
