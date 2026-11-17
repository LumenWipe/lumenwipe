import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PollarClient, type Storage as PollarStorage } from "@pollar/core";
import PollarOption from "@/components/api-keys/PollarOption";
import {
  hasStoredPollarSession,
  POLLAR_LOAD_FAILED,
  PollarLoadError,
  pollarSignInLoader,
  type PollarSignInComponent,
} from "@/components/api-keys/pollar-loader";
import type { PollarSignInProps } from "@/components/api-keys/PollarSignIn";
import { fakeFetch } from "./fixtures/fetch";
import { expectFocused } from "./fixtures/focus";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const CHOOSE = "Continue with Google or GitHub";
const SESSION_KEY = "pollar:h:session";

let rendered: PollarSignInProps[];

function StandIn(props: PollarSignInProps) {
  rendered.push(props);
  return (
    <h2 tabIndex={-1} ref={(node) => void (props.focusHeading && node?.focus())}>
      Loaded sign-in
    </h2>
  );
}

const loaded = () => mock(async (): Promise<PollarSignInComponent> => StandIn);

function props(fields: Partial<PollarSignInProps> = {}): PollarSignInProps {
  return {
    signedIn: false,
    disabled: false,
    onAccount: () => undefined,
    onLogoutChange: () => undefined,
    ...fields,
  };
}

beforeEach(() => {
  rendered = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  mock.restore();
});

test("pollar option › nothing loads on mount without a saved session", async () => {
  const load = loaded();
  render(<PollarOption {...props()} load={load} />);
  await act(async () => undefined);
  expect(screen.getByRole("heading", { name: "Or continue with an account" })).toBeTruthy();
  expect(screen.getByRole("button", { name: CHOOSE })).toBeTruthy();
  expect(load).not.toHaveBeenCalled();
});

test("pollar option › pointing at or focusing the choice starts the load, once", async () => {
  const importSignIn = mock(async (): Promise<PollarSignInComponent> => StandIn);
  render(<PollarOption {...props()} load={pollarSignInLoader(importSignIn)} />);
  const choice = screen.getByRole("button", { name: CHOOSE });
  fireEvent.pointerEnter(choice);
  fireEvent.focus(choice);
  fireEvent.pointerEnter(choice);
  await act(async () => undefined);
  expect(importSignIn).toHaveBeenCalledTimes(1);
  expect(rendered).toEqual([]);

  fireEvent.click(choice);
  expect(await screen.findByRole("heading", { name: "Loaded sign-in" })).toBeTruthy();
  expect(importSignIn).toHaveBeenCalledTimes(1);
});

test("pollar option › choosing it loads the sign-in, hands it the same props and moves focus to it", async () => {
  const load = loaded();
  const given = props({ onAccount: mock() });
  render(<PollarOption {...given} load={load} />);
  fireEvent.click(screen.getByRole("button", { name: CHOOSE }));
  const heading = await screen.findByRole("heading", { name: "Loaded sign-in" });
  await expectFocused(heading, "loaded sign-in heading");
  expect(load).toHaveBeenCalledTimes(1);
  expect(rendered.at(-1)).toEqual({ ...given, focusHeading: true });
  expect(screen.queryByRole("button", { name: CHOOSE })).toBeNull();
});

test("pollar option › a load that fails says so in plain words, and choosing again retries", async () => {
  const importSignIn = mock(async (): Promise<PollarSignInComponent> => {
    throw new Error("ChunkLoadError: Loading chunk 123 failed");
  });
  render(<PollarOption {...props()} load={pollarSignInLoader(importSignIn)} />);
  fireEvent.click(screen.getByRole("button", { name: CHOOSE }));
  expect((await screen.findByRole("alert")).textContent).toBe(POLLAR_LOAD_FAILED);
  expect(screen.queryByText(/ChunkLoadError/)).toBeNull();

  importSignIn.mockImplementation(async () => StandIn);
  fireEvent.click(screen.getByRole("button", { name: CHOOSE }));
  expect(await screen.findByRole("heading", { name: "Loaded sign-in" })).toBeTruthy();
  expect(importSignIn).toHaveBeenCalledTimes(2);
});

test("pollar option › a failed prefetch is tried again when the visitor chooses it", async () => {
  const importSignIn = mock(async (): Promise<PollarSignInComponent> => {
    throw new Error("offline");
  });
  render(<PollarOption {...props()} load={pollarSignInLoader(importSignIn)} />);
  const choice = screen.getByRole("button", { name: CHOOSE });
  fireEvent.pointerEnter(choice);
  await act(async () => undefined);
  expect(screen.queryByRole("alert")).toBeNull();

  importSignIn.mockImplementation(async () => StandIn);
  fireEvent.click(choice);
  expect(await screen.findByRole("heading", { name: "Loaded sign-in" })).toBeTruthy();
  expect(importSignIn).toHaveBeenCalledTimes(2);
});

test("pollar option › a session Pollar saved loads the sign-in on mount, without moving focus", async () => {
  localStorage.setItem(SESSION_KEY, "{}");
  const load = loaded();
  render(<PollarOption {...props()} load={load} />);
  const heading = await screen.findByRole("heading", { name: "Loaded sign-in" });
  expect(load).toHaveBeenCalledTimes(1);
  expect(rendered.at(-1)?.focusHeading).toBe(false);
  expect(document.activeElement).not.toBe(heading);
});

test("pollar option › signed in, it shows nothing and loads nothing unless a session is saved", async () => {
  const load = loaded();
  const { container, rerender } = render(
    <PollarOption {...props({ signedIn: true })} load={load} />
  );
  await act(async () => undefined);
  expect(container.innerHTML).toBe("");
  expect(load).not.toHaveBeenCalled();

  rerender(<PollarOption {...props({ signedIn: false })} load={load} />);
  expect(screen.getByRole("button", { name: CHOOSE })).toBeTruthy();
});

test("pollar option › signed in with a saved session, the loaded sign-in stays mounted to log out", async () => {
  localStorage.setItem(SESSION_KEY, "{}");
  render(<PollarOption {...props({ signedIn: true })} load={loaded()} />);
  await screen.findByRole("heading", { name: "Loaded sign-in" });
  expect(rendered.at(-1)?.signedIn).toBe(true);
});

test("pollar loader › one load is shared, and a failed one is a plain error that is not kept", async () => {
  const importSignIn = mock(async (): Promise<PollarSignInComponent> => {
    throw new Error("offline");
  });
  const load = pollarSignInLoader(importSignIn);
  const failure = await load().catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(PollarLoadError);
  expect((failure as Error).message).toBe(POLLAR_LOAD_FAILED);

  importSignIn.mockImplementation(async () => StandIn);
  const [first, second] = await Promise.all([load(), load()]);
  expect(first).toBe(StandIn);
  expect(second).toBe(StandIn);
  expect(importSignIn).toHaveBeenCalledTimes(2);
});

test("stored pollar session › only a saved session counts, not Pollar's other keys", () => {
  expect(hasStoredPollarSession()).toBe(false);
  localStorage.setItem("pollar:h:walletType", "smart");
  localStorage.setItem("pollar:h:dpopNonce", "n");
  localStorage.setItem("other:session", "{}");
  localStorage.setItem(SESSION_KEY, "");
  expect(hasStoredPollarSession()).toBe(false);
  localStorage.setItem(SESSION_KEY, "{}");
  expect(hasStoredPollarSession()).toBe(true);
});

test("stored pollar session › storage that cannot be read holds no session", () => {
  localStorage.setItem(SESSION_KEY, "{}");
  const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
  try {
    expect(hasStoredPollarSession()).toBe(false);
  } finally {
    Object.defineProperty(globalThis, "localStorage", own);
  }
  expect(hasStoredPollarSession()).toBe(true);
});

test("stored pollar session › the key Pollar's own client restores its session from counts", async () => {
  const network = spyOn(globalThis, "fetch").mockImplementation(
    fakeFetch(async () => {
      throw new Error("no network in unit tests");
    })
  );
  const reads: string[] = [];
  const storage: PollarStorage = {
    get: async (key) => {
      reads.push(key);
      return null;
    },
    set: async () => undefined,
    remove: async () => undefined,
  };
  installIndexedDb();
  const quiet = () => undefined;
  const client = new PollarClient({
    apiKey: "unit-placeholder-not-a-key",
    storage,
    logger: { error: quiet, warn: quiet, info: quiet, debug: quiet },
  });
  await client.ready();
  client.destroy();
  removeIndexedDb();

  const sessionReads = reads.filter((key) => {
    localStorage.clear();
    localStorage.setItem(key, "{}");
    return hasStoredPollarSession();
  });
  expect(sessionReads).toHaveLength(1);
  expect(reads.length).toBeGreaterThan(1);
  expect(network).not.toHaveBeenCalled();
});
