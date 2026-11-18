"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody } from "@/components/ui/card";
import {
  hasStoredPollarSession,
  loadPollarSignIn,
  POLLAR_LOAD_FAILED,
  type PollarSignInComponent,
} from "./pollar-loader";
import type { PollarSignInProps } from "./PollarSignIn";

export interface PollarOptionProps extends PollarSignInProps {
  load?: () => Promise<PollarSignInComponent>;
}

/**
 * Google, GitHub and email sign-in without Pollar's code at page load: it loads when the visitor
 * chooses it, or on load when Pollar kept a session here to restore.
 */
export default function PollarOption({
  load = loadPollarSignIn,
  ...props
}: PollarOptionProps): ReactElement | null {
  const [SignIn, setSignIn] = useState<PollarSignInComponent | null>(null);
  const [chosen, setChosen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hasStoredPollarSession()) return;
    let active = true;
    load().then(
      (component) => {
        if (active) setSignIn(() => component);
      },
      () => {
        if (active) setFailed(true);
      }
    );
    return () => {
      active = false;
    };
  }, [load]);

  const prefetch = (): void => {
    load().catch(() => undefined);
  };

  const choose = (): void => {
    setChosen(true);
    setLoading(true);
    setFailed(false);
    load().then(
      (component) => setSignIn(() => component),
      () => {
        setLoading(false);
        setFailed(true);
      }
    );
  };

  if (SignIn) return <SignIn {...props} focusHeading={chosen} />;
  if (props.signedIn) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <h2 className="text-base font-semibold text-white">Or continue with an account</h2>
        <Button
          variant="secondary"
          loading={loading}
          disabled={props.disabled}
          onPointerEnter={prefetch}
          onFocus={prefetch}
          onClick={choose}
        >
          Continue with Google, GitHub or email
        </Button>
        {failed && <Callout tone="danger">{POLLAR_LOAD_FAILED}</Callout>}
      </CardBody>
    </Card>
  );
}
