import { expect, test } from "bun:test";
import {
  envTemplateDrift,
  readsIn,
  templateEntries,
  webEnvTemplateDrift,
} from "@/scripts/check-env-template";

test("env-template › a variable the app reads but the template omits is reported", () => {
  const reads = readsIn("const id = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;");
  expect(envTemplateDrift({ reads, template: templateEntries("LUMENWIPE_API_URL=\n") })).toEqual([
    "NEXT_PUBLIC_UMAMI_WEBSITE_ID is read by the web app but missing from .env.example",
    "LUMENWIPE_API_URL is in .env.example but the web app never reads it",
  ]);
});

test("env-template › a template entry nothing reads is reported", () => {
  expect(
    envTemplateDrift({
      reads: new Set(["LUMENWIPE_API_URL"]),
      template: templateEntries(
        "LUMENWIPE_API_URL=http://localhost:3001\nMEDIATOR_SECRET_TESTNET=\n"
      ),
    })
  ).toEqual(["MEDIATOR_SECRET_TESTNET is in .env.example but the web app never reads it"]);
});

test("env-template › platform variables need no entry, and agreement reports nothing", () => {
  const reads = readsIn(
    'if (process.env.NODE_ENV === "development" && process.env.VERCEL_ENV && process.env.CI) {}\nprocess.env.LUMENWIPE_API_KEY;'
  );
  expect(envTemplateDrift({ reads, template: new Set(["LUMENWIPE_API_KEY"]) })).toEqual([]);
});

test("env-template › reads are found through dot and bracket access", () => {
  expect([
    ...readsIn(`process.env.A_ONE; process.env["B_TWO"]; process.env[ 'C_THREE' ]; env.D_FOUR;`),
  ]).toEqual(["A_ONE", "B_TWO", "C_THREE"]);
});

test("env-template › only uncommented NAME= lines are entries", () => {
  expect([
    ...templateEntries("# KEPT_OUT=\nKEPT=value\n  INDENTED=\nlower=\n\nALSO_KEPT=\n"),
  ]).toEqual(["KEPT", "ALSO_KEPT"]);
});

test("env-template › apps/web/.env.example lists exactly what the web app reads", () => {
  expect(webEnvTemplateDrift()).toEqual([]);
});
