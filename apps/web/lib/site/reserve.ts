// Read from the Stellar docs on 2026-11-14 and from mainnet's latest ledger on 2026-11-15
// (base_reserve_in_stroops 5000000, ledger 65498548). The base reserve is a network parameter
// validators can vote to change.
export const BASE_RESERVE_XLM = 0.5;
export const MINIMUM_BALANCE_RESERVES = 2;
/** The day `BASE_RESERVE_XLM` was last checked against the network's base reserve. */
export const BASE_RESERVE_CHECKED_ON = "2026-11-15";
