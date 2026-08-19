"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stocks, type IndexStock } from "../../lib/stocks";
import { SegmentRing } from "./segment-ring";
import { StockifyMark } from "./site-chrome";
import { CoinMark } from "./coin-mark";
import { StockLogo } from "./stock-logo";

/** Raw units to a short human string, without pulling in a formatting dependency. */
function formatUnits(raw: string, decimals: number) {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
import { truncateAddress, useWallet, type Eip1193Provider } from "./wallet";

type TradeTarget = {
  address: string;
  name: string;
  stock?: IndexStock;
  symbol: string;
};

/** Prices the panel without prompting for a wallet. Velora rejects placeholder-looking addresses,
 *  so the protocol's own vault stands in: a real address we control, whose preview calldata is
 *  never sent. A genuine quote is fetched the moment a wallet connects. */
const PREVIEW_ADDRESS = process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS
  ?? "0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98";

type VeloraQuote = {
  destAmount: string;
  /** Comes back from the route now, so the panel no longer has to infer 8-vs-18 from the target. */
  destDecimals: number;
  executable?: boolean;
  tx: { to: string; data: string; value: string };
  venues: string[];
};

type SwapTransaction = {
  chainId: number;
  data: string;
  to: string;
  value: string;
};

const baseChainHex = "0x2105";
/** Velora's native-asset sentinel. Paying in ETH needs no wrap and no approval. */
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const stockifyAddress = process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS ?? "";

function isConfiguredAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function toWei(value: string) {
  if (!/^\d*(\.\d*)?$/.test(value)) throw new Error("Enter a valid ETH amount.");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > 18) throw new Error("ETH supports up to 18 decimals.");
  const normalized = `${whole || "0"}${fraction.padEnd(18, "0")}`.replace(/^0+/, "") || "0";
  if (BigInt(normalized) <= 0n) throw new Error("Enter an amount greater than zero.");
  return normalized;
}

async function postJson<T>(path: string, body: unknown) {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = await response.json().catch(() => ({ error: "Unexpected response from swap service." })) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Uniswap could not complete this request.");
  return payload;
}

/**
 * Adapted from 21st's Currency Exchange Card (component 8204): clear asset
 * legs and a single, prominent conversion action. This implementation uses
 * real Uniswap API quotes and sends the resulting transaction only through
 * the connected wallet.
 */
export function SwapPanel() {
  const targets = useMemo<TradeTarget[]>(() => [
    { address: stockifyAddress, name: "Stockify protocol token", symbol: "STFY" },
    ...stocks.filter((stock) => stock.inIndex)
      .map((stock) => ({ address: stock.address, name: stock.name, stock, symbol: stock.symbol })),
  ], []);
  const { account, connect, provider } = useWallet();
  const [amount, setAmount] = useState("0.10");
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [quote, setQuote] = useState<VeloraQuote>();
  const [quoteAt, setQuoteAt] = useState(0);
  const [targetSymbol, setTargetSymbol] = useState("STFY");
  const [kycUrl, setKycUrl] = useState<string>();
  const quoteToken = useRef(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [isPickerOpen, setPickerOpen] = useState(false);

  // A dropdown that ignores Escape or a click elsewhere is a dropdown that traps you.
  useEffect(() => {
    if (!isPickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isPickerOpen]);

  const target = targets.find((entry) => entry.symbol === targetSymbol) ?? targets[0];
  // An address is not a market: the ETH/STFY pool is not initialised yet, so quoting it would ask
  // Velora for a route that cannot exist. Gated on the pool id, which only exists once it does.
  const needsStockifyConfig = target.symbol === "STFY" && !process.env.NEXT_PUBLIC_STOCKIFY_POOL_ID;

  function clearTradeState() {
    setKycUrl(undefined);
    setNotice(undefined);
    setQuote(undefined);
    setQuoteAt(0);
  }

  const requestQuote = useCallback(async (swapper?: string) => {
    if (needsStockifyConfig) return;
    const wei = toWei(amount);
    if (!wei || wei === "0") { clearTradeState(); return; }

    // Only the newest request may write state: typing fires several, and they can land out of order.
    const token = ++quoteToken.current;
    const forWallet = swapper ?? account;
    setIsBusy(true);
    try {
      if (forWallet) {
        const permission = await postJson<{ allowed?: boolean }>("/api/b20/policy", {
          token: target.address,
          walletAddress: forWallet,
        });
        if (token !== quoteToken.current) return;
        if (permission.allowed === false) {
          setKycUrl(`https://basescan.org/address/${target.address}`);
          setNotice("This tokenized market requires wallet verification before it can be traded.");
          return;
        }
      }

      const nextQuote = await postJson<VeloraQuote>("/api/velora/swap", {
        amount: wei,
        // The route takes both legs by address and resolves decimals from its own allowlist — a
        // client-supplied `destDecimals` was one typo away from quoting a trade 10^10 too large.
        srcToken: NATIVE_ETH,
        destToken: target.address,
        swapper: forWallet ?? PREVIEW_ADDRESS,
      });
      if (token !== quoteToken.current) return;
      setKycUrl(undefined);
      setQuote({ ...nextQuote, executable: Boolean(forWallet) });
      setQuoteAt(Date.now());
      // Named venues were the wrong answer to "is this a good fill?". Nobody buying a share needs
      // to know it cleared on aerodromeslipstreamfactory3; they need to know the aggregator looked
      // and this was the best route it found. `notice` is left for problems only.
      setNotice(undefined);
    } catch (error) {
      if (token !== quoteToken.current) return;
      setQuote(undefined);
      setNotice(error instanceof Error ? error.message : "Unable to price this trade.");
    } finally {
      if (token === quoteToken.current) setIsBusy(false);
    }
  }, [account, amount, needsStockifyConfig, target]);

  // Quote as the amount is typed, settled by a short pause. Without a wallet this prices only —
  // asking someone to connect before they can see a number is the wrong order.
  useEffect(() => {
    const timer = setTimeout(() => { void requestQuote(); }, 450);
    return () => clearTimeout(timer);
  }, [requestQuote]);

  async function connectThenQuote() {
    try {
      const next = await connect();
      await requestQuote(next);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Wallet connection failed.");
    }
  }

  async function executeSwap() {
    if (!quote?.executable || !account) return;
    if (Date.now() - quoteAt > 30_000) {
      setQuote(undefined);
      setNotice("This quote has expired. Request a fresh quote before confirming.");
      return;
    }
    setIsBusy(true);
    try {
      const transactionHash = await provider().request({
        method: "eth_sendTransaction",
        params: [{
          data: quote.tx.data,
          from: account,
          to: quote.tx.to,
          value: `0x${BigInt(quote.tx.value).toString(16)}`,
        }],
      });
      setNotice(`Transaction submitted: ${typeof transactionHash === "string" ? truncateAddress(transactionHash) : "view in wallet"}.`);
      setQuote(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Wallet could not submit this trade.");
    } finally {
      setIsBusy(false);
    }
  }

  const actionLabel = needsStockifyConfig
    ? "STFY pool pending"
    : isBusy
    ? "Preparing route…"
    : quote?.executable
      ? "Confirm in wallet"
      : "Connect wallet";

  return (
    <aside className="swap-panel" aria-label="Buy Stockify or a Base tokenized stock">
      <div className="swap-panel-head"><div><span>BUY ON BASE</span><strong>Trade ETH for stocks</strong></div></div>
      <div className="swap-leg">
        <label htmlFor="swap-amount">You pay</label>
        <div><input id="swap-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); clearTradeState(); }} placeholder="0.00" value={amount} /><span className="swap-currency"><CoinMark symbol="ETH" size={17} />ETH</span></div>
      </div>
      <div className="swap-divider" aria-hidden="true"><span>↓</span></div>
      <div className="swap-leg swap-leg-output">
        <label htmlFor="swap-target">You receive</label>
        <div className="swap-target-row">
          <output className="swap-output" htmlFor="swap-amount">{quote ? formatUnits(quote.destAmount, quote.destDecimals) : "—"}</output>
          <div className="asset-select" ref={pickerRef}>
            <button
              aria-expanded={isPickerOpen}
              aria-haspopup="listbox"
              className="asset-trigger"
              id="swap-target"
              onClick={() => setPickerOpen((open) => !open)}
              type="button"
            >
              {target.stock ? <StockLogo stock={target.stock} /> : <StockifyMark small />}
              <span>{target.symbol}</span>
              <svg aria-hidden="true" className="asset-caret" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></svg>
            </button>
            {isPickerOpen && (
              <ul className="asset-menu" role="listbox" tabIndex={-1}>
                {targets.map((entry) => (
                  <li key={entry.symbol}>
                    <button
                      aria-selected={entry.symbol === targetSymbol}
                      className={entry.symbol === targetSymbol ? "is-active" : undefined}
                      onClick={() => { setTargetSymbol(entry.symbol); clearTradeState(); setPickerOpen(false); }}
                      role="option"
                      type="button"
                    >
                      {entry.stock ? <StockLogo stock={entry.stock} /> : <StockifyMark small />}
                      <span className="asset-symbol">{entry.symbol}</span>
                      <span className="asset-name">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <div className="swap-details"><span>Input</span><b>Native ETH</b><span>Target</span><b>{target.symbol === "STFY" ? "Custom-hook pool" : "Base B20 token"}</b></div>
      {notice ? (
        <p className={`swap-notice${quote ? " is-ready" : ""}`}>{notice}</p>
      ) : quote ? (
        <p className="trade-route">
          <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
            <path d="M3.5 8.4l3 3 6-6.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Best price available
        </p>
      ) : null}
      {kycUrl && <a className="swap-kyc" href={kycUrl} rel="noreferrer" target="_blank">Verify wallet to trade ↗</a>}
      <button className="swap-action" disabled={isBusy || Boolean(kycUrl) || needsStockifyConfig} onClick={quote?.executable ? executeSwap : connectThenQuote} type="button">{isBusy ? <SegmentRing filled={2} motion="spin" size={15} stroke={16} /> : null}{actionLabel}</button>
    </aside>
  );
}
