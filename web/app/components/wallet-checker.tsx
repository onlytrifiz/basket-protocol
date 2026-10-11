"use client";

import Link from "next/link";
import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { shares as fmtShares, usdCompact } from "../../lib/format";
import type { WalletDividends } from "../../lib/wallet-dividends";
import { CountUp } from "./count-up";
import { StockLogo } from "./stock-logo";
import { useWallet } from "./wallet";

const isAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value.trim());
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** Up to four decimals: a holder's payout is often a few hundredths of a share. */
const fine = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 });
const date = (seconds: number | null) =>
  seconds === null ? "—" : new Date(seconds * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

type State =
  | { kind: "idle" }
  | { kind: "loading"; address: string }
  | { kind: "error"; message: string }
  | { kind: "done"; recap: WalletDividends };

/**
 * The wallet checker on /dividends, in two pieces that share one state: the lookup bar sits in the
 * page's heading, and the recap opens directly under the heading once something is asked. Before a
 * lookup the page is exactly as it was.
 *
 * The address is written into the URL (`?wallet=…`) without navigating, so a recap is still a link
 * someone can send, and a link like that loads it on arrival. Data comes from /api/wallet: one
 * filtered explorer request per stock and a single chain batch, cached per wallet for ten minutes.
 */
type Checker = { state: State; value: string; setValue: (v: string) => void; load: (raw: string) => void; clear: () => void; resultRef: React.RefObject<HTMLDivElement | null> };
const CheckerContext = createContext<Checker | null>(null);
const useChecker = () => {
  const value = useContext(CheckerContext);
  if (!value) throw new Error("WalletCheck pieces must sit inside <WalletCheckProvider>");
  return value;
};

export function WalletCheckProvider({ children }: { children: React.ReactNode }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const resultRef = useRef<HTMLDivElement | null>(null);

  const run = useCallback(async (raw: string, scroll: boolean) => {
    const address = raw.trim().toLowerCase();
    if (!isAddress(address)) {
      setState({ kind: "error", message: "That is not a wallet address. It starts with 0x and has 42 characters." });
      return;
    }
    setValue(address);
    setState({ kind: "loading", address });
    const url = new URL(window.location.href);
    url.searchParams.set("wallet", address);
    url.hash = "";
    window.history.replaceState(null, "", url);
    if (scroll) requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    try {
      const response = await fetch(`/api/wallet?address=${address}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "The payouts could not be read just now.");
      setState({ kind: "done", recap: payload as WalletDividends });
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message || "The payouts could not be read just now." });
    }
  }, []);

  // A shared link (?wallet=0x…) opens with its recap already loading.
  useEffect(() => {
    const shared = new URL(window.location.href).searchParams.get("wallet");
    if (shared && isAddress(shared)) void run(shared, false);
  }, [run]);

  const load = useCallback((raw: string) => { void run(raw, true); }, [run]);
  const clear = useCallback(() => {
    setState({ kind: "idle" });
    setValue("");
    const url = new URL(window.location.href);
    url.searchParams.delete("wallet");
    window.history.replaceState(null, "", url);
    document.getElementById("wallet")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  return <CheckerContext.Provider value={{ state, value, setValue, load, clear, resultRef }}>{children}</CheckerContext.Provider>;
}

/** The lookup bar, for the page heading: one pill holding the field and both actions. */
export function WalletCheckForm() {
  const { state, value, setValue, load } = useChecker();
  const { account, connect, isConnecting } = useWallet();

  const useMine = async () => {
    try {
      load(account ?? await connect());
    } catch {
      /* the wallet did not connect: nothing to look up */
    }
  };

  return (
    <form className="wallet-bar" id="wallet" onSubmit={(event) => { event.preventDefault(); load(value); }}>
      <span className="wallet-bar-label">Check a wallet</span>
      <div className="wallet-bar-field">
        <label className="sr-only" htmlFor="wallet-address">Wallet address</label>
        <input
          autoComplete="off"
          id="wallet-address"
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste an address, 0x…"
          spellCheck={false}
          value={value}
        />
        <button className="wallet-bar-go" disabled={state.kind === "loading"} type="submit">
          {state.kind === "loading" ? "Loading" : "Show payouts"}
        </button>
      </div>
      <button className="wallet-bar-mine" disabled={isConnecting} onClick={useMine} type="button">
        {isConnecting ? "Connecting" : account ? "or use my wallet" : "or connect your wallet"}
      </button>
      {state.kind === "error" && <p className="wallet-lookup-error" role="alert">{state.message}</p>}
    </form>
  );
}

/** The recap, under the heading. Renders nothing until a lookup starts. */
export function WalletCheckResult() {
  const { state, resultRef, clear } = useChecker();
  const open = state.kind === "loading" || state.kind === "done";
  return (
    <div aria-live="polite" className={`wallet-result wrap${open ? " is-open" : ""}`} id="wallet-result" ref={resultRef}>
      {open && (
        <div className="wallet-result-head">
          <span>Payouts to {short(state.kind === "loading" ? state.address : state.recap.address)}</span>
          <button onClick={clear} type="button">Clear ×</button>
        </div>
      )}
      {state.kind === "loading" && (
        <div aria-busy="true" className="wallet-recap is-loading">
          <span className="sr-only">Loading payouts for {short(state.address)}</span>
          <i aria-hidden="true" className="sk sk-block" />
          <i aria-hidden="true" className="sk sk-block" />
        </div>
      )}
      {state.kind === "done" && <Recap recap={state.recap} />}
    </div>
  );
}

function Recap({ recap }: { recap: WalletDividends }) {
  const eligible = recap.stfyBalance !== null && recap.threshold !== null ? recap.stfyBalance >= recap.threshold : null;

  if (recap.stocks.length === 0) {
    return (
      <div className="wallet-empty">
        <h3>No payouts to {short(recap.address)} yet.</h3>
        <p>
          {eligible
            ? "This wallet holds enough STFY, so it is counted from the next settled cycle."
            : recap.threshold !== null
              ? `Hold ${fmtShares(recap.threshold)} STFY or more and this wallet is counted in every cycle.`
              : "Wallets holding enough STFY are paid in every settled cycle."}
        </p>
        <Link className="button button-ink" href="/#buy">Buy STFY <span>→</span></Link>
        {recap.partial && <p className="hub-note-degraded">Part of the history could not be read just now. Try again in a minute.</p>}
      </div>
    );
  }

  return (
    <>
      <div className="wallet-recap">
        <div className="wallet-total">
          <span>{short(recap.address)} received</span>
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
      </div>
      <div className="wallet-stocks">
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
          <a href={`https://basescan.org/address/${recap.address}#tokentxns`} rel="noreferrer" target="_blank">{short(recap.address)} ↗</a>.
        </p>
      </div>
    </>
  );
}
