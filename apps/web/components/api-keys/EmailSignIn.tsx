"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { AuthState, PollarClient } from "@pollar/core";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

/** The part of Pollar's client the email sign-in drives. */
export type EmailCodeClient = Pick<
  PollarClient,
  "onAuthStateChange" | "login" | "verifyEmailCode" | "cancelLogin"
>;

export interface EmailSignInProps {
  client: EmailCodeClient;
  disabled: boolean;
}

export const CODE_LENGTH = 6;
export const RESEND_SECONDS = 30;

/** None of these says whether an account exists for the address. */
export const EMAIL_SIGN_IN_ERRORS = {
  send: "We could not send a code. Check the address and try again in a minute.",
  invalid: "That code did not work. Check it, or send a new code.",
  expired: "That code expired. Send a new code.",
  verify: "We could not check the code. Try again.",
  other: "Email sign-in did not finish. Try again, or sign in with a Stellar wallet above.",
} as const;

type Stage = "email" | "code";
type Progress = "sending" | "verifying" | null;

const SENDING_STEPS = new Set<AuthState["step"]>(["creating_session", "sending_email"]);
const VERIFYING_STEPS = new Set<AuthState["step"]>(["verifying_email_code", "authenticating"]);
const CODE_ERRORS: Partial<Record<string, string>> = {
  EMAIL_CODE_INVALID: EMAIL_SIGN_IN_ERRORS.invalid,
  EMAIL_CODE_EXPIRED: EMAIL_SIGN_IN_ERRORS.expired,
  EMAIL_VERIFY_FAILED: EMAIL_SIGN_IN_ERRORS.verify,
};

/** Email and one-time-code sign-in, drawn here and driven through Pollar's client. */
export default function EmailSignIn({ client, disabled }: EmailSignInProps): ReactElement {
  const active = useRef(false);
  const [stage, setStage] = useState<Stage>("email");
  const [progress, setProgress] = useState<Progress>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    function follow(state: AuthState): void {
      if (SENDING_STEPS.has(state.step)) return setProgress("sending");
      if (VERIFYING_STEPS.has(state.step)) return setProgress("verifying");
      setProgress(null);
      if (state.step === "entering_code") {
        setStage("code");
        setCode("");
        setError(null);
        setCooldown(RESEND_SECONDS);
      } else if (state.step === "error") {
        const codeError = CODE_ERRORS[state.errorCode];
        if (codeError && state.previousStep === "verifying_email_code") {
          setError(codeError);
        } else {
          setStage("email");
          setError(
            state.errorCode === "EMAIL_SEND_FAILED" || state.errorCode === "SESSION_CREATE_FAILED"
              ? EMAIL_SIGN_IN_ERRORS.send
              : EMAIL_SIGN_IN_ERRORS.other
          );
        }
      } else if (state.step === "authenticated") {
        active.current = false;
        setEmail("");
        setCode("");
      } else if (state.step !== "entering_email") {
        // Idle after a cancel, or another sign-in took over.
        active.current = false;
        setStage("email");
      }
    }

    return client.onAuthStateChange((state) => {
      if (active.current) follow(state);
    });
  }, [client]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((left) => left - 1), 1_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const send = (): void => {
    setError(null);
    active.current = true;
    client.login({ provider: "email", email: email.trim() });
  };

  const submitEmail = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (disabled || progress || !email.trim()) return;
    send();
  };

  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (disabled || progress || code.length !== CODE_LENGTH) return;
    setError(null);
    client.verifyEmailCode(code);
  };

  const useAnotherEmail = (): void => {
    active.current = false;
    client.cancelLogin();
    setStage("email");
    setCode("");
    setError(null);
    setCooldown(0);
  };

  if (stage === "code") {
    return (
      <form noValidate className="space-y-3" onSubmit={submitCode}>
        <Field
          label="Code"
          helper={`Enter the ${CODE_LENGTH}-digit code we sent to ${email.trim()}. Only the newest code works.`}
          error={error ?? undefined}
        >
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
            }
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant="secondary"
            loading={progress === "verifying"}
            disabled={disabled || progress !== null || code.length !== CODE_LENGTH}
          >
            {progress === "verifying" ? "Checking the code..." : "Verify code"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            loading={progress === "sending"}
            disabled={disabled || progress !== null || cooldown > 0}
            onClick={send}
          >
            {cooldown > 0 ? `Send a new code in ${cooldown}s` : "Send a new code"}
          </Button>
          <Button type="button" variant="ghost" disabled={disabled} onClick={useAnotherEmail}>
            Use a different email
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form noValidate className="space-y-3" onSubmit={submitEmail}>
      <Field
        label="Email"
        helper="We email you a one-time code. No password needed."
        error={error ?? undefined}
      >
        <Input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Button
        type="submit"
        variant="secondary"
        loading={progress === "sending"}
        disabled={disabled || progress !== null || !email.trim()}
      >
        {progress === "sending" ? "Sending the code..." : "Continue with email"}
      </Button>
    </form>
  );
}
