/**
 * Responses captured from Horizon's `GET /paths/strict-send` (read-only, 2026-10-11), keeping
 * every field the host returned so a validation rule that rejects a real answer fails here.
 */
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SHX_ISSUER = "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH";

/** Mainnet, 10 USDC to native: one direct record with an empty path. */
export const MAINNET_LIQUID_USDC = {
  _embedded: {
    records: [
      {
        source_asset_type: "credit_alphanum4",
        source_asset_code: "USDC",
        source_asset_issuer: USDC_ISSUER,
        source_amount: "10.0000000",
        destination_asset_type: "native",
        destination_amount: "49.2658130",
        path: [],
      },
    ],
  },
};

/** Mainnet, 1 stroop of SHX to native: the smallest quote the market gave, through two hops. */
export const MAINNET_DUST_SHX = {
  _embedded: {
    records: [
      {
        source_asset_type: "credit_alphanum4",
        source_asset_code: "SHX",
        source_asset_issuer: SHX_ISSUER,
        source_amount: "0.0000001",
        destination_asset_type: "native",
        destination_amount: "0.0000001",
        path: [
          {
            asset_type: "credit_alphanum12",
            asset_code: "iShares",
            asset_issuer: "GAD5BPZHVXJJALZZJ4B6P773VGMAVYXFWFAUQFKSHUJTDO3VTOW3OSHR",
          },
          {
            asset_type: "credit_alphanum4",
            asset_code: "ETH",
            asset_issuer: "GAPGJQATZ5TDV5T7EDKHX3JMIHUSYT4XFFSM6V2J3AJBZN4ORX4MRETH",
          },
        ],
      },
    ],
  },
};

/** Mainnet and testnet, an asset nobody trades: HTTP 200 with no records. */
export const EMPTY_MARKET = { _embedded: { records: [] } };
