import type { Trustline } from "@lumenwipe/types";

export function authorizationOf(
  authorized: boolean
): Pick<Trustline, "authorized" | "authorization" | "clawbackEnabled"> {
  return {
    authorized,
    authorization: authorized ? "authorized" : "unauthorized",
    clawbackEnabled: false,
  };
}
