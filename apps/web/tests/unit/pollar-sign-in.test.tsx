import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import * as pollarReact from "@pollar/react";
import PollarSignIn, { type PollarSignInProps } from "@/components/api-keys/PollarSignIn";

type Context = ReturnType<typeof pollarReact.usePollar>;

function stubPollar(fields: Partial<Context>): void {
  const client = {
    onAuthStateChange: () => () => undefined,
    login: () => undefined,
    verifyEmailCode: () => undefined,
    cancelLogin: () => undefined,
  };
  const context = {
    isAuthenticated: false,
    wallet: null,
    login: () => undefined,
    logout: () => undefined,
    getClient: () => client,
    configStatus: "ready",
    styles: {},
    ...fields,
  } as unknown as Context;
  spyOn(pollarReact, "PollarProvider").mockImplementation(
    (({ children }: { children: ReactNode }) =>
      children) as unknown as typeof pollarReact.PollarProvider
  );
  spyOn(pollarReact, "usePollar").mockImplementation(() => context);
}

const props: PollarSignInProps = {
  signedIn: false,
  disabled: false,
  onAccount: () => undefined,
  onLogoutChange: () => undefined,
};

const emailField = () => screen.queryByRole("textbox", { name: "Email" });

afterEach(() => {
  cleanup();
  mock.restore();
});

test("pollar sign-in › offers email once Pollar's config has it on", () => {
  stubPollar({ styles: { emailEnabled: true } });
  render(<PollarSignIn {...props} />);
  expect(emailField()).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
});

test("pollar sign-in › hides email, with no error, when Pollar's config has it off", () => {
  stubPollar({ styles: { emailEnabled: false } });
  render(<PollarSignIn {...props} />);
  expect(emailField()).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/not available/)).toBeNull();
});

test("pollar sign-in › hides email while Pollar's config is still loading", () => {
  stubPollar({ configStatus: "loading", styles: { emailEnabled: true } });
  render(<PollarSignIn {...props} />);
  expect(emailField()).toBeNull();
});

test("pollar sign-in › a config that did not load names the wallet as the next step", () => {
  stubPollar({ configStatus: "error", styles: { emailEnabled: true } });
  render(<PollarSignIn {...props} />);
  expect(emailField()).toBeNull();
  expect(screen.getByText(/Sign in with a Stellar wallet above instead/)).toBeTruthy();
});
