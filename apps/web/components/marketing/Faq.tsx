import FaqAccordion, { type FaqItem } from "@/components/marketing/FaqAccordion";
import {
  feature,
  LIVE_EXIT_PROTOCOLS,
  listNames,
  protocolsWithStatus,
  testnetOnlySentence,
} from "@/lib/site/status";
import {
  CHECK_STATEMENT,
  KEY_STATEMENT,
  SERVER_KEYS,
  SERVER_KEYS_INTRO,
  serverKeyScope,
  VERIFY_SOURCE_URL,
} from "@/lib/site/trust";

const TESTNET_ONLY_EXITS = protocolsWithStatus("testnet-only");
const EXCHANGE_LIVE = feature("exchange-close").status === "live";

export const ITEMS: readonly FaqItem[] = [
  {
    q: "Is LumenWipe really non-custodial?",
    a: (
      <>
        Yes. {KEY_STATEMENT} {CHECK_STATEMENT} {SERVER_KEYS_INTRO}{" "}
        {SERVER_KEYS.map((key) => (
          <span key={key.name}>
            {key.name}: {key.statement} {serverKeyScope(key)}{" "}
          </span>
        ))}
        The check is open source:{" "}
        <a
          href={VERIFY_SOURCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-4"
        >
          verify.ts<span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </>
    ),
  },
  {
    q: "Is closing an account reversible?",
    a: (
      <>
        No. <span className="mkt-mono text-white/80">ACCOUNT_MERGE</span> permanently removes the
        source account from the Stellar ledger. Because the action is irreversible, LumenWipe shows
        the complete plan up front, simulates each step, and asks for explicit confirmation (with
        the raw XDR available to review) before every signature.
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
        {EXCHANGE_LIVE ? "Yes." : "On testnet today."} Exchanges don&apos;t support{" "}
        <span className="mkt-mono text-white/80">ACCOUNT_MERGE</span>, so LumenWipe routes the final
        merge through a shared relay account in one atomic transaction and pays out to your deposit
        address with the correct memo. Known exchanges are validated against a registry that
        enforces the required memo type, so deposits don&apos;t go missing.
        {EXCHANGE_LIVE
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
        <span className="text-white/80">{listNames(LIVE_EXIT_PROTOCOLS)}</span> on mainnet
        {TESTNET_ONLY_EXITS.length > 0 && (
          <>
            ;{" "}
            <span data-site-status="testnet-only">
              <span className="text-white/80">{listNames(TESTNET_ONLY_EXITS)}</span> exits run on
              testnet only
            </span>
          </>
        )}
        . Classic order-book offers are cancelled as part of every close. Classic AMM pool shares
        are not unwound: they are reported as a blocker, so withdraw them with another tool first.
      </>
    ),
  },
  {
    q: "Which wallets are supported?",
    a: (
      <>
        Any SEP-43 wallet through{" "}
        <span className="mkt-mono text-white/80">stellar-wallets-kit</span>: Varial (formerly
        Freighter), xBull, Albedo, LOBSTR, Hana, WalletConnect and more. Power users can also use an
        advanced secret-key mode where the key is held in memory only for the duration of the close,
        never persisted and never sent to a server, and cleared when you finish, abort, navigate
        away, or click &quot;Forget key&quot;.
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
        <span data-site-status="testnet-only">{testnetOnlySentence()}</span> Closing an account on
        mainnet is irreversible and entirely at your own risk: review each step, the simulation
        result, and the destination address before you sign anything.
      </>
    ),
  },
];

export default function Faq() {
  return <FaqAccordion items={ITEMS} />;
}
