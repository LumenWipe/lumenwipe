"use client";

import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { PollarProvider, usePollar } from "@pollar/react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";

/** An account Pollar signed in, with a way to sign the API's challenge as it. */
export interface PollarAccount {
  address: string;
  /** A Pollar smart account: a contract account that cannot sign the challenge. */
  smart: boolean;
  /** The challenge's SEP-53 signature, or null when Pollar did not sign. */
  sign: (message: string) => Promise<string | null>;
}

export interface PollarSignInProps {
  /** True while the page holds a key-management session: nothing to sign in to. */
  signedIn: boolean;
  disabled: boolean;
  onAccount: (account: PollarAccount) => void;
  /** Receives Pollar's logout while an account is signed in there, and null otherwise. */
  onLogoutChange: (logout: (() => Promise<void> | void) | null) => void;
  /** Moves focus to the card's heading once it shows, after the visitor asked for this sign-in. */
  focusHeading?: boolean;
}

const POLLAR_CLIENT = { apiKey: process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY ?? "" };

/** Google and GitHub sign-in through Pollar, loaded only through pollar-loader.ts. */
export default function PollarSignIn(props: PollarSignInProps): ReactElement {
  return (
    <PollarProvider client={POLLAR_CLIENT}>
      <PollarSignInCard {...props} />
    </PollarProvider>
  );
}

function PollarSignInCard({
  signedIn,
  disabled,
  onAccount,
  onLogoutChange,
  focusHeading,
}: PollarSignInProps): ReactElement | null {
  const { isAuthenticated, wallet, login, logout, getClient, configStatus } = usePollar();
  const handled = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const address = wallet?.address ?? null;
  const smart = wallet?.custody === "smart";

  const sign = useCallback(
    async (message: string): Promise<string | null> => {
      const proof = await getClient().stellar.sep53.signMessage(message);
      return proof.status === "signed" ? proof.signature : null;
    },
    [getClient]
  );

  useEffect(() => {
    onLogoutChange(isAuthenticated ? logout : null);
  }, [isAuthenticated, logout, onLogoutChange]);

  useEffect(() => {
    if (!isAuthenticated) handled.current = null;
    // An account already signed in here when the key session ends is offered again, never signed
    // with on its own.
    if (signedIn && isAuthenticated && address) handled.current = address;
    if (!isAuthenticated || !address || signedIn || handled.current === address) return;
    handled.current = address;
    onAccount({ address, smart, sign });
  }, [isAuthenticated, address, signedIn, smart, sign, onAccount]);

  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);

  if (signedIn) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <h2 ref={heading} tabIndex={-1} className="text-base font-semibold text-white">
          Or continue with an account
        </h2>
        {isAuthenticated && address ? (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => {
                handled.current = address;
                onAccount({ address, smart, sign });
              }}
            >
              Verify the account I signed in with
            </Button>
            <Button variant="ghost" disabled={disabled} onClick={() => void logout()}>
              Use another account
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              disabled={disabled || configStatus !== "ready"}
              onClick={() => login({ provider: "google" })}
            >
              Continue with Google
            </Button>
            <Button
              variant="secondary"
              disabled={disabled || configStatus !== "ready"}
              onClick={() => login({ provider: "github" })}
            >
              Continue with GitHub
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
