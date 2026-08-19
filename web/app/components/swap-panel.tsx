"use client";

import { useMemo, useState } from "react";
import { stocks, type IndexStock } from "../../lib/stocks";
import { SegmentRing } from "./segment-ring";
import { StockifyMark } from "./site-chrome";
import { StockLogo } from "./stock-logo";
import { truncateAddress, useWallet, type Eip1193Provider } from "./wallet";

type TradeTarget = {
  address: string;
  name: string;
  stock?: IndexStock;
  symbol: string;
};

type VeloraQuote = {
  destAmount: string;
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

  async function requestQuote() {
    if (needsStockifyConfig) {
      setNotice("STFY is awaiting its deployed token and pool address. Stock quotes are available to check now.");
      return;
    }

    setIsBusy(true);
    clearTradeState();
    try {
      const swapper = account ?? await connect();
      const permission = await postJson<{ results?: Array<{ isAllowlisted?: boolean; isPermissioned?: boolean; kycUrl?: string }> }>("/api/uniswap/permissions", {
        token: target.address,
        walletAddress: swapper,
      });
      const result = permission.results?.[0];
      if (result?.isPermissioned && !result.isAllowlisted) {
        setKycUrl(result.kycUrl);
        setNotice("This tokenized market requires wallet verification before it can be traded.");
        return;
      }

      const nextQuote = await postJson<VeloraQuote>("/api/velora/swap", {
        amount: toWei(amount),
        decimals: target.stock ? 8 : 18,
        swapper,
        tokenOut: target.address,
      });
      setQuote(nextQuote);
      setQuoteAt(Date.now());
      // Naming the venues is the point of routing through Velora: this depth is split across
      // Aerodrome and Uniswap, and the trader should see which ones filled the order.
      setNotice(`Route ready via ${nextQuote.venues.join(" + ") || "Velora"}. Review and confirm within 30 seconds.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to prepare this trade.");
    } finally {
      setIsBusy(false);
    }
  }

  async function executeSwap() {
    if (!quote || !account) return;
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
    : quote
      ? "Confirm in wallet"
      : account
        ? "Get quote"
        : "Connect wallet";

  return (
    <aside className="swap-panel" aria-label="Buy Stockify or a Base tokenized stock">
      <div className="swap-panel-head"><div><span>BUY ON BASE</span><strong>Trade ETH for stocks</strong></div><b>UNISWAP v4</b></div>
      <div className="swap-leg">
        <label htmlFor="swap-amount">You pay</label>
        <div><input id="swap-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); clearTradeState(); }} placeholder="0.00" value={amount} /><span className="swap-currency">ETH</span></div>
      </div>
      <div className="swap-divider" aria-hidden="true"><span>↓</span></div>
      <div className="swap-leg swap-leg-output">
        <label htmlFor="swap-target">You receive</label>
        <div className="swap-target-row">
          {target.stock ? <StockLogo stock={target.stock} /> : <StockifyMark />}
          <select id="swap-target" onChange={(event) => { setTargetSymbol(event.target.value); clearTradeState(); }} value={targetSymbol}>
            {targets.map((entry) => <option key={entry.symbol} value={entry.symbol}>{entry.symbol} · {entry.name}</option>)}
          </select>
        </div>
      </div>
      <div className="swap-details"><span>Input</span><b>Native ETH</b><span>Target</span><b>{target.symbol === "STFY" ? "Custom-hook pool" : "Base B20 token"}</b></div>
      {notice && <p className={`swap-notice${quote ? " is-ready" : ""}`}>{notice}</p>}
      {kycUrl && <a className="swap-kyc" href={kycUrl} rel="noreferrer" target="_blank">Verify wallet to trade ↗</a>}
      <button className="swap-action" disabled={isBusy || Boolean(kycUrl) || needsStockifyConfig} onClick={quote ? executeSwap : requestQuote} type="button">{isBusy ? <SegmentRing filled={2} motion="spin" size={15} stroke={16} /> : null}{actionLabel}</button>
      <p className="swap-foot">{account ? `Connected ${truncateAddress(account)}` : "Wallet signs the transaction; Stockify never takes custody."}</p>
    </aside>
  );
}
