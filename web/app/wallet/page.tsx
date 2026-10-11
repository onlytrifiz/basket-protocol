import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { shares as fmtShares, usdCompact } from "../../lib/format";
import { isWalletAddress, readWalletDividends } from "../../lib/wallet-dividends";
import { CountUp } from "../components/count-up";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { StockLogo } from "../components/stock-logo";
import { WalletLookup } from "../components/wallet-lookup";

export const metadata: Metadata = {
  title: "Your stock dividends · Stockify",
  description: "Every tokenized stock the Stockify dividend vault has pushed to a wallet, all time.",
};

export const dynamic = "force-dynamic";

const date = (seconds: number | null) =>
  seconds === null ? "—" : new Date(seconds * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

/** Up to four decimals: a holder's payout is often a few hundredths of a share. */
const fine = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 });

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

async function Recap({ address }: { address: string }) {
  const recap = await readWalletDividends(address);
  const eligible = recap.stfyBalance !== null && recap.threshold !== null ? recap.stfyBalance >= recap.threshold : null;

  if (recap.stocks.length === 0) {
    return (
      <section className="wrap wallet-empty">
        <h2>No payouts to {short(address)} yet.</h2>
        <p>
          {eligible
            ? "This wallet holds enough STFY, so it is counted from the next settled cycle."
            : recap.threshold !== null
              ? `Hold ${fmtShares(recap.threshold)} STFY or more and this wallet is counted in every cycle.`
              : "Wallets holding enough STFY are paid in every settled cycle."}
        </p>
        <div className="hero-actions"><Link className="button button-ink" href="/#buy">Buy STFY <span>→</span></Link></div>
        {recap.partial && <p className="hub-note-degraded">Part of the history could not be read just now. Try again in a minute.</p>}
      </section>
    );
  }

  return (
    <>
      <section className="wrap wallet-recap">
        <div className="wallet-total">
          <span>Received, all time</span>
          <strong><CountUp format="usdCompact" value={recap.totalValue} /></strong>
          <small>at today&apos;s prices, across {recap.stocks.length} {recap.stocks.length === 1 ? "stock" : "stocks"}</small>
        </div>
        <dl className="wallet-facts">
          <div><dt>Payouts</dt><dd>{recap.totalPayouts.toLocaleString("en-US")}</dd></div>
          <div><dt>First paid</dt><dd>{date(recap.firstPaidAt)}</dd></div>
          <div><dt>Last paid</dt><dd>{date(recap.lastPaidAt)}</dd></div>
          <div>
            <dt>STFY held</dt>
            <dd>{recap.stfyBalance === null ? "—" : fmtShares(recap.stfyBalance)}</dd>
            {eligible !== null && (
              <small className={eligible ? "is-eligible" : "is-below"}>
                {eligible ? "eligible for the next cycle" : `below the ${fmtShares(recap.threshold ?? 0)} threshold`}
              </small>
            )}
          </div>
        </dl>
      </section>

      <section className="wrap wallet-stocks">
        <ul>
          {recap.stocks.map((stock) => (
            <li key={stock.address}>
              <Link href={`/stocks/${stock.symbol.toLowerCase()}`}>
                <span className="wallet-stock-id">
                  <StockLogo logo={stock.logo} size="small" stock={{ symbol: stock.symbol, domain: stock.domain }} />
                  <span><b>{stock.symbol}</b><small>{stock.name}</small></span>
                </span>
                <span className="wallet-stock-figures">
                  <b>{stock.value === null ? fine(stock.shares) : usdCompact(stock.value)}</b>
                  <small>{fine(stock.shares)} shares · {stock.payouts.toLocaleString("en-US")} payouts</small>
                  {stock.unpaid > 0 && <small className="is-below">{fine(stock.unpaid)} owed, retried next cycle</small>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="wallet-note">
          {recap.partial ? "Part of the history could not be read just now, so these totals are a floor. " : ""}
          Every row is a transfer from the dividend vault to{" "}
          <a href={`https://basescan.org/address/${address}#tokentxns`} rel="noreferrer" target="_blank">{short(address)} ↗</a>.
        </p>
      </section>
    </>
  );
}

function RecapSkeleton() {
  return (
    <div aria-busy="true" className="wrap wallet-recap is-loading">
      <span className="sr-only" role="status">Loading payouts</span>
      <i aria-hidden="true" className="sk sk-block" />
      <i aria-hidden="true" className="sk sk-block" />
    </div>
  );
}

export default async function WalletPage({ searchParams }: PageProps<"/wallet">) {
  const raw = (await searchParams).address;
  const address = typeof raw === "string" && isWalletAddress(raw) ? raw.toLowerCase() : null;

  return (
    <div className="site-shell">
      <SiteHeader />
      <main>
        <header className="section wrap hub-head wallet-head">
          <div className="hub-head-copy">
            <p className="eyebrow">Your dividends</p>
            <h1>{address ? `What ${short(address)} has received.` : "What has your wallet received?"}</h1>
            <p className="hub-lede">Every stock the dividend vault has pushed to a wallet, all time, valued at today&apos;s prices.</p>
            <WalletLookup initial={address ?? ""} />
          </div>
        </header>
        {address && (
          <Suspense fallback={<RecapSkeleton />} key={address}>
            <Recap address={address} />
          </Suspense>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
