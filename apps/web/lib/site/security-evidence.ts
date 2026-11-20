import { REPO_URL } from "@/lib/site/trust";

/** The repository files that enforce a statement, and the tests that prove it. Repo-relative. */
export interface Evidence {
  code: readonly string[];
  tests: readonly string[];
}

export type GuaranteeId = "key" | "steps" | "memo" | "api" | "csp";

export type FeeId = "network" | "service" | "sponsored" | "relay" | "conversion";

/** Each guarantee on the security page, with the code and tests behind it (docs/invariants.mdx). */
export const GUARANTEE_EVIDENCE: Record<GuaranteeId, Evidence> = {
  key: {
    code: ["apps/web/lib/stellar/signer.ts", "apps/web/hooks/useActiveSigner.ts"],
    tests: ["apps/web/tests/unit/execution-wizard.test.tsx", "apps/web/tests/unit/signer.test.ts"],
  },
  steps: {
    code: ["apps/web/lib/api/close-decisions.ts", "apps/web/hooks/useCloseExecution.ts"],
    tests: [
      "apps/web/tests/unit/close-decisions.test.ts",
      "apps/web/tests/unit/signing-guards.test.tsx",
    ],
  },
  memo: {
    code: [
      "apps/web/lib/exchange-registry/index.ts",
      "apps/web/lib/plan/memo-requirement.ts",
      "apps/web/lib/stellar/verify.ts",
    ],
    tests: [
      "apps/web/tests/unit/memo-requirement.test.ts",
      "apps/web/tests/unit/exchange-registry.test.ts",
      "apps/web/tests/unit/verify.test.ts",
    ],
  },
  api: {
    code: ["apps/web/lib/stellar/verify.ts", "apps/api/src/mediator/mediator-signing.service.ts"],
    tests: [
      "apps/web/tests/unit/verify.test.ts",
      "apps/web/tests/unit/verify-conformance.test.ts",
      "apps/api/tests/unit/mediator-validation.test.ts",
    ],
  },
  csp: {
    code: [
      "apps/web/proxy.ts",
      "apps/web/config/marketing-csp.mjs",
      "apps/web/scripts/marketing-csp.mjs",
      "scripts/audit-gate.ts",
      "apps/web/eslint.config.mjs",
    ],
    tests: [
      "apps/web/tests/unit/proxy.test.ts",
      "apps/web/tests/unit/marketing-csp.test.ts",
      "scripts/audit-gate.test.ts",
      "apps/web/tests/unit/boundary-lint.test.ts",
    ],
  },
};

/** Each row of the fee table, with the code that sets or refuses that fee and its tests. */
export const FEE_EVIDENCE: Record<FeeId, Evidence> = {
  network: {
    code: ["apps/web/config/constants.ts", "apps/api/src/lib/close-api/plan-fee.ts"],
    tests: ["apps/api/tests/unit/plan-fee.test.ts"],
  },
  service: {
    code: ["apps/web/lib/stellar/verify.ts"],
    tests: ["apps/web/tests/unit/verify.test.ts"],
  },
  sponsored: {
    code: ["apps/api/src/fee-bump/fee-bump.controller.ts"],
    tests: ["apps/api/tests/unit/fee-bump-controller.test.ts"],
  },
  relay: {
    code: ["apps/api/src/lib/stellar/tx-builder/merge.ts", "apps/web/lib/stellar/verify.ts"],
    tests: ["apps/api/tests/unit/mediatorMerge.test.ts", "apps/web/tests/unit/verify.test.ts"],
  },
  conversion: {
    code: [
      "apps/api/src/lib/close-api/token-conversion-round.ts",
      "apps/web/lib/stellar/verify.ts",
    ],
    tests: ["apps/web/tests/unit/verify.test.ts"],
  },
};

/** A repository file's page on GitHub, at the head of main. */
export function repoFileUrl(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}

/** The repository file's name, as a link's label. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
