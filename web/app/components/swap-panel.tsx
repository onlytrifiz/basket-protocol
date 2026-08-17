"use client";

import { useMemo, useState } from "react";
import { stocks, type IndexStock } from "../../lib/stocks";
import { StockifyMark } from "./site-chrome";
import { StockLogo } from "./stock-logo";

type Eip1193Provider = {
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

type TradeTarget = {
  address: string;
  name: string;
  stock?: IndexStock;
  symbol: string;
};

type RouterQuote = {
  quote: { output?: { amount?: string; minimumAmount?: string } };
  routing?: string;
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

function truncateAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
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
    ...stocks.map((stock) => ({ address: stock.address, name: stock.name, stock, symbol: stock.symbol })),
  ], []);
  const [account, setAccount] = useState<string>();
  const [amount, setAmount] = useState("0.10");
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [quote, setQuote] = useState<RouterQuote>();
  const [quoteAt, setQuoteAt] = useState(0);
  const [targetSymbol, setTargetSymbol] = useState("STFY");
  const [kycUrl, setKycUrl] = useState<string>();

  const target = targets.find((entry) => entry.symbol === targetSymbol) ?? targets[0];
  const needsStockifyConfig = target.symbol === "STFY" && !isConfiguredAddress(target.address);

  async function ensureBase(provider: Eip1193Provider) {
    const currentChain = await provider.request({ method: "eth_chainId" });
    if (currentChain === baseChainHex) return;

    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: baseChainHex }] });
    } catch (error) {
      const walletError = error as { code?: number };
      if (walletError.code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          blockExplorerUrls: ["https://basescan.org"],
          chainId: baseChainHex,
          chainName: "Base Mainnet",
          nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
          rpcUrls: ["https://mainnet.base.org"],
        }],
      });
    }
  }

  async function connectWallet() {
    const provider = window.ethereum;
    if (!provider) throw new Error("Install a wallet such as Coinbase Wallet or MetaMask to trade.");
    await ensureBase(provider);
    const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
    const nextAccount = accounts[0];
    if (!nextAccount) throw new Error("No wallet account was selected.");
    setAccount(nextAccount);
    return nextAccount;
  }

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
      const swapper = account ?? await connectWallet();
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

      const nextQuote = await postJson<RouterQuote>("/api/uniswap/quote", {
        amount: toWei(amount),
        swapper,
        tokenOut: target.address,
      });
      setQuote(nextQuote);
      setQuoteAt(Date.now());
      setNotice(`Route ready via Uniswap ${nextQuote.routing === "CLASSIC" ? "v4" : "router"}. Review and confirm within 30 seconds.`);
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
    if (quote.routing !== "CLASSIC") {
      setQuote(undefined);
      setNotice("This route needs a different Uniswap execution method. Request a new quote shortly.");
      return;
    }

    const provider = window.ethereum;
    if (!provider) {
      setNotice("Wallet connection was lost. Connect again before confirming.");
      return;
    }

    setIsBusy(true);
    try {
      const { swap } = await postJson<{ swap: SwapTransaction }>("/api/uniswap/swap", { quote: quote.quote });
      const transactionHash = await provider.request({
        method: "eth_sendTransaction",
        params: [{
          data: swap.data,
          from: account,
          to: swap.to,
          value: `0x${BigInt(swap.value).toString(16)}`,
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
      <button className="swap-action" disabled={isBusy || Boolean(kycUrl) || needsStockifyConfig} onClick={quote ? executeSwap : requestQuote} type="button">{actionLabel}</button>
      <p className="swap-foot">{account ? `Connected ${truncateAddress(account)}` : "Wallet signs the transaction; Stockify never takes custody."}</p>
    </aside>
  );
}
