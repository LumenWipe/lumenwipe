import type { FaqItem } from "@/components/marketing/FaqAccordion";
import type { Locale } from "@/lib/i18n/locale";

/** The registry facts and trust statements the answers are built from, so each answer follows
 *  the registry instead of freezing what it said when it was written. */
export interface FaqFacts {
  keyStatement: string;
  checkStatement: string;
  serverKeysIntro: string;
  serverKeys: readonly { name: string; statement: string; scope: string }[];
  verifySourceUrl: string;
  newTab: string;
  exchangeLive: boolean;
  /** The protocols with a mainnet exit, as a list. */
  liveExits: string;
  /** The protocols whose exits run on testnet only, as a list; "" when there are none. */
  testnetOnlyExits: string;
  testnetOnlySentence: string;
}

const items = (ctx: FaqFacts): readonly FaqItem[] => [
  {
    q: "Is LumenWipe really non-custodial?",
    a: (
      <>
        Yes. {ctx.keyStatement} {ctx.checkStatement} {ctx.serverKeysIntro}{" "}
        {ctx.serverKeys.map((key) => (
          <span key={key.name}>
            {key.name}: {key.statement} {key.scope}{" "}
          </span>
        ))}
        The check is open source:{" "}
        <a
          href={ctx.verifySourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-4"
        >
          verify.ts<span className="sr-only">{ctx.newTab}</span>
        </a>
        .
      </>
    ),
  },
  {
    q: "Is closing an account reversible?",
    a: (
      <>
        No. The final merge permanently removes the account from the Stellar ledger. Because the
        action is irreversible, LumenWipe shows the complete plan up front, simulates each step, and
        asks for explicit confirmation (with the raw transaction available to review) before every
        signature.
      </>
    ),
  },
  {
    q: "How much XLM will I actually get back?",
    a: (
      <>
        Everything recoverable. Stellar requires a <span className="text-value">1 XLM</span> minimum
        balance (two base reserves) plus <span className="text-value">0.5 XLM</span> for each
        subentry: every trustline, open offer, data entry, and extra signer. LumenWipe unwinds all
        of them to release those reserves, converts leftover tokens to XLM, and sweeps the full
        balance to your destination.
      </>
    ),
  },
  {
    q: "Can I send the recovered XLM straight to an exchange?",
    a: (
      <>
        {ctx.exchangeLive ? "Yes." : "On testnet today."} Exchanges don&apos;t accept an account
        merge as a deposit, so LumenWipe routes the final merge through a relay account: a shared
        account that receives the merge and, in the same transaction, pays the balance out to your
        deposit address with the correct memo. Known exchanges are validated against a registry that
        enforces the required memo type, so deposits don&apos;t go missing.
        {ctx.exchangeLive
          ? ""
          : " On mainnet, the plan blocks an exchange close until the relay account is deployed there, so close to a wallet you control instead."}
      </>
    ),
  },
  {
    q: "Does it handle Soroban DeFi positions?",
    a: (
      <>
        Yes. LumenWipe detects positions through OctoPos and exits them in{" "}
        <span className="text-white/80">{ctx.liveExits}</span> on mainnet
        {ctx.testnetOnlyExits !== "" && (
          <>
            ;{" "}
            <span data-site-status="testnet-only">
              <span className="text-white/80">{ctx.testnetOnlyExits}</span> exits run on testnet
              only
            </span>
          </>
        )}
        . Classic order-book offers are cancelled as part of every close. Classic AMM pool shares
        are not unwound: they are reported as a blocker, so withdraw your liquidity from the pool
        first.
      </>
    ),
  },
  {
    q: "Which wallets are supported?",
    a: (
      <>
        Any wallet that Stellar Wallets Kit connects: Varial (formerly Freighter), xBull, Albedo,
        LOBSTR, Hana, WalletConnect and more. Power users can also use an advanced secret-key mode
        where the key is held in memory only for the duration of the close, never persisted and
        never sent to a server, and cleared when you finish, abort, navigate away, or click
        &quot;Forget key&quot;.
      </>
    ),
  },
  {
    q: "What if I close the tab in the middle?",
    a: (
      <>
        Anything already confirmed on the network stays done. Once you confirm the plan, this
        browser keeps a small record of the close: the account, the destination, the memo and the
        hash of any transaction still waiting, never your keys. When you come back in the same
        browser, the home page offers to resume: LumenWipe re-reads the account and builds a fresh
        plan for what is left, which you review and sign again, so confirmed work is not repeated.
        If a transaction was still waiting for the network, you check its outcome first. Your
        per-asset choices are kept only in this tab, so a reload shows them again for you to check;
        in another tab, or once this one is closed, you make them again.
      </>
    ),
  },
  {
    q: "Mainnet or testnet?",
    a: (
      <>
        Both. Run the entire flow on testnet with no real funds at risk to see exactly what will
        happen, then switch to mainnet for the real close.{" "}
        <span data-site-status="testnet-only">{ctx.testnetOnlySentence}</span> Closing an account on
        mainnet is irreversible and entirely at your own risk: review each step, the simulation
        result, and the destination address before you sign anything.
      </>
    ),
  },
];

const en = {
  eyebrow: "FAQ",
  heading: "Questions, answered.",
  lede: "Closing an account is irreversible. Here's exactly how LumenWipe keeps it safe.",
  items,
  page: {
    title: "FAQ",
    description:
      "Answers to the common questions about closing a Stellar account with LumenWipe: non-custodial signing, irreversibility, exchange merges, Soroban DeFi, supported wallets and resumable sessions.",
    openApp: "Open the app",
    docs: "Read the documentation",
  },
};

export type FaqCopy = typeof en;

export const FAQ: Record<Locale, FaqCopy> = { en };
