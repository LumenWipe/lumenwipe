import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { StatefulPlanAccordion } from "./fixtures/plan-accordion";
import { freshAccount } from "./fixtures/account";

const ADDRESS = Keypair.random().publicKey();
const OWNER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const POOL_ID = "d714bc2e56f74a4a4de2e81284a35b6fe09582f081bf785fc698310895c2d845";
const short = (id: string): string => `${id.slice(0, 8)}…${id.slice(-8)}`;

test("plan-accordion sponsorships › a sponsored pool share line names its pool and owner, like a trustline", () => {
  render(
    <StatefulPlanAccordion
      network="testnet"
      account={freshAccount(ADDRESS, {
        numSponsoring: 3,
        sponsoredEntries: [
          { kind: "trustline", owner: OWNER, asset: `USDC:${ISSUER}` },
          { kind: "pool_share_trustline", owner: OWNER, poolId: POOL_ID },
        ],
      })}
      conversions={[]}
      assetDispositions={{}}
      transferDestinations={{}}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
      isImpactConfirmed={() => false}
      onConfirmImpact={() => {}}
      claimableBalanceDecisions={[]}
      claimableBalanceSelections={{}}
      onSelectClaimableBalance={() => {}}
      destinationAddress={null}
      mediatorRequired={false}
    />
  );

  const rows = screen.getAllByText(new RegExp(`on ${short(OWNER)}`)).map((el) => el.parentElement);
  expect(rows.map((row) => row?.textContent)).toEqual([
    `Trustline for USDC on ${short(OWNER)}`,
    `Share trustline for liquidity pool ${short(POOL_ID)} on ${short(OWNER)}`,
  ]);
});
