/**
 * Pins the facade's documented types to the web signatures they front, in both directions and
 * key for key. Checked by `tsc -p tests` (the package's type-check); the runtime assertion below
 * only keeps the file in the suite. A field added, removed, renamed or retyped on either side
 * fails the type-check until both agree.
 */
import { expect, test } from "bun:test";
import type { verifyCloseTransaction as webVerifyCloseTransaction } from "../../../apps/web/lib/stellar/verify";
import type {
  ExitExpectations as WebExitExpectations,
  exitExpectations as webExitExpectations,
} from "../../../apps/web/lib/stellar/exit-expectations";
import type {
  CloseExpectationInput,
  ExitExpectations,
  exitExpectations,
  verifyCloseTransaction,
  VerifyCloseInput,
} from "../src/index";

type Assignable<A, B> = [A] extends [B] ? true : false;
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
/** True only when each type is assignable to the other and both name the same keys, so an extra
 *  optional field on one side (which assignability alone tolerates) still fails. */
type Pinned<A, B> =
  Assignable<A, B> extends true ? (Assignable<B, A> extends true ? SameKeys<A, B> : false) : false;

type WebInput = Parameters<typeof webVerifyCloseTransaction>[0];
type WebExpected = WebInput["expected"];
type Value<T> = T[keyof T];

const pins = {
  input: true satisfies Pinned<VerifyCloseInput, WebInput>,
  expected: true satisfies Pinned<CloseExpectationInput, WebExpected>,
  transfer: true satisfies Pinned<
    Value<CloseExpectationInput["transfers"]>,
    Value<WebExpected["transfers"]>
  >,
  tokenTransfer: true satisfies Pinned<
    Value<CloseExpectationInput["tokenTransfers"]>,
    Value<WebExpected["tokenTransfers"]>
  >,
  tokenConversion: true satisfies Pinned<
    Value<CloseExpectationInput["tokenConversions"]>,
    Value<WebExpected["tokenConversions"]>
  >,
  classicConversion: true satisfies Pinned<
    Value<CloseExpectationInput["classicConversions"]>,
    Value<WebExpected["classicConversions"]>
  >,
  verifyReturn: true satisfies Pinned<
    ReturnType<typeof verifyCloseTransaction>,
    ReturnType<typeof webVerifyCloseTransaction>
  >,
  exit: true satisfies Pinned<ExitExpectations, WebExitExpectations>,
  exitParams: true satisfies Pinned<
    Parameters<typeof exitExpectations>,
    Parameters<typeof webExitExpectations>
  >,
  exitReturn: true satisfies Pinned<
    ReturnType<typeof exitExpectations>,
    ReturnType<typeof webExitExpectations>
  >,
};

test("the facade's types are pinned to the web signatures", () => {
  expect(Object.values(pins).every((pinned) => pinned)).toBe(true);
});
