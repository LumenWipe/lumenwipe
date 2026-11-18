import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AuthState, PollarLoginOptions } from "@pollar/core";
import EmailSignIn, {
  EMAIL_SIGN_IN_ERRORS,
  RESEND_SECONDS,
  type EmailCodeClient,
} from "@/components/api-keys/EmailSignIn";

const EMAIL = "owner@example.test";

/** A stand-in for Pollar's client: it records each call and lets the test emit auth states. */
function fakeClient() {
  const listeners = new Set<(state: AuthState) => void>();
  let state: AuthState = { step: "idle" };
  const fake = {
    listeners,
    login: mock((_options: PollarLoginOptions) => undefined),
    verifyEmailCode: mock((_code: string) => undefined),
    cancelLogin: mock(() => undefined),
    onAuthStateChange(cb: (next: AuthState) => void) {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
    emit(next: AuthState) {
      state = next;
      act(() => {
        for (const cb of [...listeners]) cb(next);
      });
    },
  };
  return fake;
}

type Fake = ReturnType<typeof fakeClient>;
let client: Fake;

const emailBox = () => screen.getByRole("textbox", { name: "Email" });
const codeBox = () => screen.getByRole("textbox", { name: "Code" });
const button = (name: string | RegExp) => screen.getByRole("button", { name });

function show(disabled = false) {
  return render(<EmailSignIn client={client as EmailCodeClient} disabled={disabled} />);
}

function sendCode() {
  fireEvent.change(emailBox(), { target: { value: `  ${EMAIL} ` } });
  fireEvent.click(button("Continue with email"));
  client.emit({ step: "creating_session" });
  client.emit({ step: "sending_email", email: EMAIL });
  client.emit({ step: "entering_code", clientSessionId: "s1", email: EMAIL });
}

function codeError(errorCode: "EMAIL_CODE_INVALID" | "EMAIL_CODE_EXPIRED" | "EMAIL_VERIFY_FAILED") {
  client.emit({
    step: "error",
    previousStep: "verifying_email_code",
    message: "from Pollar",
    errorCode,
    clientSessionId: "s1",
    email: EMAIL,
  });
}

beforeEach(() => {
  client = fakeClient();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  mock.restore();
});

test("email sign-in › sends the trimmed address through Pollar's email login, not its modal", () => {
  show();
  expect(button("Continue with email").hasAttribute("disabled")).toBe(true);
  fireEvent.change(emailBox(), { target: { value: `  ${EMAIL} ` } });
  fireEvent.click(button("Continue with email"));
  expect(client.login).toHaveBeenCalledTimes(1);
  expect(client.login).toHaveBeenCalledWith({ provider: "email", email: EMAIL });
});

test("email sign-in › shows progress while the code is sent, then asks for the code", () => {
  show();
  fireEvent.change(emailBox(), { target: { value: EMAIL } });
  fireEvent.click(button("Continue with email"));
  client.emit({ step: "creating_session" });
  expect(button(/Sending the code/).getAttribute("aria-busy")).toBe("true");
  client.emit({ step: "entering_code", clientSessionId: "s1", email: EMAIL });
  expect(codeBox().getAttribute("autocomplete")).toBe("one-time-code");
  expect(codeBox().getAttribute("inputmode")).toBe("numeric");
  expect(screen.getByText(new RegExp(`6-digit code we sent to ${EMAIL}`))).toBeTruthy();
});

test("email sign-in › keeps only six digits and verifies them through Pollar", () => {
  show();
  sendCode();
  const verify = button("Verify code");
  expect(verify.hasAttribute("disabled")).toBe(true);
  fireEvent.change(codeBox(), { target: { value: "12 34-56789" } });
  expect((codeBox() as HTMLInputElement).value).toBe("123456");
  fireEvent.click(verify);
  expect(client.verifyEmailCode).toHaveBeenCalledWith("123456");
  client.emit({ step: "verifying_email_code", clientSessionId: "s1", email: EMAIL });
  expect(button(/Checking the code/).getAttribute("aria-busy")).toBe("true");
});

test("email sign-in › a new code can be asked for only after the cooldown", () => {
  jest.useFakeTimers();
  show();
  sendCode();
  expect(client.login).toHaveBeenCalledTimes(1);
  const resend = () => button(/Send a new code/);
  expect(resend().textContent).toBe(`Send a new code in ${RESEND_SECONDS}s`);
  expect(resend().hasAttribute("disabled")).toBe(true);
  fireEvent.click(resend());
  expect(client.login).toHaveBeenCalledTimes(1);

  for (let second = 0; second < RESEND_SECONDS; second++) {
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
  }
  expect(resend().textContent).toBe("Send a new code");
  fireEvent.click(resend());
  expect(client.login).toHaveBeenCalledTimes(2);
  expect(client.login).toHaveBeenLastCalledWith({ provider: "email", email: EMAIL });
  client.emit({ step: "entering_code", clientSessionId: "s2", email: EMAIL });
  expect(resend().hasAttribute("disabled")).toBe(true);
});

test("email sign-in › a different email cancels the login and starts over", () => {
  show();
  sendCode();
  fireEvent.click(button("Use a different email"));
  expect(client.cancelLogin).toHaveBeenCalledTimes(1);
  client.emit({ step: "idle" });
  expect(emailBox()).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Code" })).toBeNull();
});

test("email sign-in › a code error stays on the code and never says whether an account exists", () => {
  show();
  sendCode();
  const cases = [
    ["EMAIL_CODE_INVALID", EMAIL_SIGN_IN_ERRORS.invalid],
    ["EMAIL_CODE_EXPIRED", EMAIL_SIGN_IN_ERRORS.expired],
    ["EMAIL_VERIFY_FAILED", EMAIL_SIGN_IN_ERRORS.verify],
  ] as const;
  for (const [errorCode, message] of cases) {
    codeError(errorCode);
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(codeBox().getAttribute("aria-invalid")).toBe("true");
  }
  expect(screen.queryByText(/from Pollar/)).toBeNull();
  for (const message of Object.values(EMAIL_SIGN_IN_ERRORS)) {
    expect(message).not.toMatch(/account|registered|exist/i);
  }
});

test("email sign-in › a failed send returns to the address with a plain error", () => {
  show();
  fireEvent.change(emailBox(), { target: { value: EMAIL } });
  fireEvent.click(button("Continue with email"));
  client.emit({
    step: "error",
    previousStep: "sending_email",
    message: "Failed to send code",
    errorCode: "EMAIL_SEND_FAILED",
  });
  expect(screen.getByRole("alert").textContent).toBe(EMAIL_SIGN_IN_ERRORS.send);
  expect((emailBox() as HTMLInputElement).value).toBe(EMAIL);
});

test("email sign-in › a sign-in that fails after the code names the wallet as the next step", () => {
  show();
  sendCode();
  client.emit({
    step: "error",
    previousStep: "authenticating",
    message: "x",
    errorCode: "AUTH_FAILED",
  });
  expect(screen.getByRole("alert").textContent).toBe(EMAIL_SIGN_IN_ERRORS.other);
  expect(emailBox()).toBeTruthy();
});

test("email sign-in › ignores Pollar's states until the visitor sends a code", () => {
  show();
  client.emit({ step: "opening_oauth", provider: "google" });
  client.emit({
    step: "error",
    previousStep: "opening_oauth",
    message: "x",
    errorCode: "AUTH_FAILED",
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(emailBox()).toBeTruthy();
});

test("email sign-in › the fields carry no name and submitting never navigates", () => {
  const before = window.location.href;
  show();
  expect(emailBox().hasAttribute("name")).toBe(false);
  fireEvent.change(emailBox(), { target: { value: EMAIL } });
  const submitted = fireEvent.submit(emailBox().closest("form")!);
  expect(submitted).toBe(false);
  client.emit({ step: "entering_code", clientSessionId: "s1", email: EMAIL });
  expect(codeBox().hasAttribute("name")).toBe(false);
  expect(window.location.href).toBe(before);
});

function stored(): string {
  return [localStorage, sessionStorage]
    .flatMap((storage) =>
      Array.from({ length: storage.length }, (_, i) => {
        const key = storage.key(i) ?? "";
        return `${key}=${storage.getItem(key) ?? ""}`;
      })
    )
    .join("\n");
}

test("email sign-in › the address is kept in no browser storage, after the send or after success", () => {
  show();
  sendCode();
  expect(stored()).not.toContain("example.test");
  fireEvent.change(codeBox(), { target: { value: "123456" } });
  fireEvent.click(button("Verify code"));
  client.emit({ step: "authenticating" });
  client.emit({
    step: "authenticated",
    session: {} as Extract<AuthState, { step: "authenticated" }>["session"],
    verified: true,
  });
  expect(stored()).not.toContain("example.test");
});

test("email sign-in › stops listening to Pollar once it is gone", () => {
  const errors = spyOn(console, "error");
  const { unmount } = show();
  expect(client.listeners.size).toBe(1);
  fireEvent.change(emailBox(), { target: { value: EMAIL } });
  fireEvent.click(button("Continue with email"));
  unmount();
  expect(client.listeners.size).toBe(0);
  client.emit({ step: "entering_code", clientSessionId: "s1", email: EMAIL });
  expect(errors).not.toHaveBeenCalled();
});

test("email sign-in › disabled while another sign-in runs", () => {
  show(true);
  fireEvent.change(emailBox(), { target: { value: EMAIL } });
  expect(button("Continue with email").hasAttribute("disabled")).toBe(true);
  fireEvent.submit(emailBox().closest("form")!);
  expect(client.login).not.toHaveBeenCalled();
});
