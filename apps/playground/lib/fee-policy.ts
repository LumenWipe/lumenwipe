// The API's fee rules the playground's sponsored close relies on, restated because apps/playground
// never imports apps/api. tests/unit/fee-policy.test.ts pins each to the API constant it mirrors.

/** The API's `BASE_FEE_STROOPS`: what a close transaction bids per operation. */
export const CLOSE_FEE_PER_OPERATION_STROOPS = BigInt(100);

/** The API's `MAX_FEE_BUMP_STROOPS`: the most outer fee its sponsor signs for, a full
 *  100-operation inner transaction plus the fee-bump itself at the base fee. */
export const MAX_SPONSORED_FEE_STROOPS = BigInt(101) * CLOSE_FEE_PER_OPERATION_STROOPS;
