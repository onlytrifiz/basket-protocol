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

type TradeAsset = {
  address: string;
  name: string;
  stock?: IndexStock;
  symbol: string;
  /** ETH and STFY are 18; every B20 equity is EIGHT. Amounts here are raw base units, and the
   *  decimals travel with the ASSET rather than with the field — which is the whole reason a
   *  selectable pay side is safe. */
  decimals: number;
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
  /** Velora's `tokenTransferProxy`, which is NOT the transaction's `to`. Null when paying in ETH.
   *  Approving the wrong address fails silently and looks like a broken swap. */
  spender: string | null;
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

/**
 * Slippage, in basis points. Fixed, and generous.
 *
 * NO PICKER, because there is nothing here for a user to tune against: Base has no public mempool,
 * so the sandwich this setting exists to prevent elsewhere cannot be built. What is left is ordinary
 * price movement between quote and signature, and 5% simply absorbs it — well clear of the 300 bps
 * the STFY hook takes on the way through, which is itself why an AMM front-end's 0.5% would reject
 * the trade outright.
 */
const SLIPPAGE_BPS = 500;
/** Velora's native-asset sentinel. Paying in ETH needs no wrap and no approval. */
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const stockifyAddress = process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS ?? "";

function isConfiguredAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function toBaseUnits(value: string, decimals: number) {
  if (!/^\d*(\.\d*)?$/.test(value)) throw new Error("Enter a valid amount.");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`This asset supports up to ${decimals} decimals.`);
  const normalized = `${whole || "0"}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  if (BigInt(normalized) <= 0n) throw new Error("Enter an amount greater than zero.");
  return normalized;
}

const pad32 = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

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
  // ETH sits in the same list as everything else now, because it can be either leg: buying STFY is
  // ETH -> STFY and selling it is the same trade read backwards.
  const assets = useMemo<TradeAsset[]>(() => [
    { address: NATIVE_ETH, name: "Ether", symbol: "ETH", decimals: 18 },
    { address: stockifyAddress, name: "Stockify protocol token", symbol: "STFY", decimals: 18 },
    ...stocks.filter((stock) => stock.inIndex)
      .map((stock) => ({ address: stock.address, name: stock.name, stock, symbol: stock.symbol, decimals: 8 })),
  ], []);
  const { account, connect, provider } = useWallet();
  const [amount, setAmount] = useState("0.10");
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [quote, setQuote] = useState<VeloraQuote>();
  const [quoteAt, setQuoteAt] = useState(0);
  const [sourceSymbol, setSourceSymbol] = useState("ETH");
  const [targetSymbol, setTargetSymbol] = useState("STFY");
  const [needsApproval, setNeedsApproval] = useState(false);
  const [kycUrl, setKycUrl] = useState<string>();
  const quoteToken = useRef(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  /** Which leg's dropdown is open, if any — the two pickers share one outside-click handler. */
  const [openPicker, setOpenPicker] = useState<"source" | "target" | null>(null);

  // A dropdown that ignores Escape or a click elsewhere is a dropdown that traps you.
  useEffect(() => {
    if (!openPicker) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpenPicker(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenPicker(null); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openPicker]);

  const source = assets.find((entry) => entry.symbol === sourceSymbol) ?? assets[0];
  const target = assets.find((entry) => entry.symbol === targetSymbol) ?? assets[1];
  /** The B20 leg, whichever side it is on — that is the one with a transfer policy. */
  const policyLeg = source.stock ? source : target.stock ? target : null;
  // An address is not a market: the ETH/STFY pool is not initialised yet, so quoting it would ask
  // Velora for a route that cannot exist. Gated on the pool id, which only exists once it does.
  const needsStockifyConfig =
    (target.symbol === "STFY" || source.symbol === "STFY") && !process.env.NEXT_PUBLIC_STOCKIFY_POOL_ID;

  /** Swap the legs. Picking the asset already on the other side flips rather than duplicating it. */
  function flip() {
    setSourceSymbol(targetSymbol);
    setTargetSymbol(sourceSymbol);
    clearTradeState();
  }

  function clearTradeState() {
    setKycUrl(undefined);
    setNotice(undefined);
    setQuote(undefined);
    setQuoteAt(0);
    setNeedsApproval(false);
  }

  const requestQuote = useCallback(async (swapper?: string) => {
    if (needsStockifyConfig) return;
    let raw: string;
    try { raw = toBaseUnits(amount, source.decimals); }
    catch (error) { clearTradeState(); setNotice(error instanceof Error ? error.message : undefined); return; }

    // Only the newest request may write state: typing fires several, and they can land out of order.
    const token = ++quoteToken.current;
    const forWallet = swapper ?? account;
    setIsBusy(true);
    try {
      if (forWallet && policyLeg) {
        // Buying the equity makes the wallet its RECEIVER; selling makes it the SENDER. Checking the
        // wrong scope clears a wallet the transfer then rejects.
        const permission = await postJson<{ allowed?: boolean }>("/api/b20/policy", {
          token: policyLeg.address,
          walletAddress: forWallet,
          scope: policyLeg === source ? "sender" : "receiver",
        });
        if (token !== quoteToken.current) return;
        if (permission.allowed === false) {
          setKycUrl(`https://basescan.org/address/${policyLeg.address}`);
          setNotice("This tokenized market requires wallet verification before it can be traded.");
          return;
        }
      }

      const nextQuote = await postJson<VeloraQuote>("/api/velora/swap", {
        amount: raw,
        // The route takes both legs by address and resolves decimals from its own allowlist — a
        // client-supplied `destDecimals` was one typo away from quoting a trade 10^10 too large.
        srcToken: source.address,
        destToken: target.address,
        slippageBps: SLIPPAGE_BPS,
        swapper: forWallet ?? PREVIEW_ADDRESS,
      });
      if (token !== quoteToken.current) return;
      setKycUrl(undefined);
      setQuote({ ...nextQuote, executable: Boolean(forWallet) });
      setQuoteAt(Date.now());

      // Selling anything but ETH moves an ERC-20 the router has to be allowed to pull, and the
      // spender is Velora's proxy rather than the transaction's `to`.
      if (forWallet && nextQuote.spender) {
        const allowance = await provider().request({
          method: "eth_call",
          params: [{ to: source.address, data: `0xdd62ed3e${pad32(forWallet)}${pad32(nextQuote.spender)}` }, "latest"],
        });
        if (token === quoteToken.current) {
          setNeedsApproval(BigInt(typeof allowance === "string" && allowance !== "0x" ? allowance : "0x0") < BigInt(raw));
        }
      } else {
        setNeedsApproval(false);
      }
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
  }, [account, amount, needsStockifyConfig, policyLeg, provider, source, target]);

  // Quote as the amount is typed, settled by a short pause. Without a wallet this prices only —
  // asking someone to connect before they can see a number is the wrong order.
  useEffect(() => {
    const timer = setTimeout(() => { void requestQuote(); }, 450);
    return () => clearTimeout(timer);
  }, [requestQuote]);

  async function approve() {
    if (!quote?.spender || !account) return;
    setIsBusy(true);
    try {
      await provider().request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: source.address, data: `0x095ea7b3${pad32(quote.spender)}${"f".repeat(64)}` }],
      });
      setNeedsApproval(false);
      setNotice("Approval submitted. Confirm the swap once it has been mined.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The approval was rejected.");
    } finally {
      setIsBusy(false);
    }
  }

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
    ? "Working…"
    : needsApproval
      ? `Approve ${source.symbol}`
      : quote?.executable
        ? "Confirm in wallet"
        : "Connect wallet";

  /** One picker, rendered twice. Choosing the asset already on the other leg flips the pair rather
   *  than producing a trade of something for itself. */
  const picker = (side: "source" | "target") => {
    const current = side === "source" ? source : target;
    const other = side === "source" ? target : source;
    return (
      <div className="asset-select" ref={openPicker === side ? pickerRef : undefined}>
        <button
          aria-expanded={openPicker === side}
          aria-haspopup="listbox"
          className="asset-trigger"
          id={side === "target" ? "swap-target" : "swap-source"}
          onClick={() => setOpenPicker((open) => (open === side ? null : side))}
          type="button"
        >
          {current.stock ? <StockLogo stock={current.stock} /> : current.symbol === "ETH"
            ? <CoinMark symbol="ETH" size={22} /> : <StockifyMark small />}
          <span>{current.symbol}</span>
          <svg aria-hidden="true" className="asset-caret" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></svg>
        </button>
        {openPicker === side && (
          <ul className="asset-menu" role="listbox" tabIndex={-1}>
            {assets.map((entry) => (
              <li key={entry.symbol}>
                <button
                  aria-selected={entry.symbol === current.symbol}
                  className={entry.symbol === current.symbol ? "is-active" : undefined}
                  onClick={() => {
                    if (entry.symbol === other.symbol) flip();
                    else if (side === "source") { setSourceSymbol(entry.symbol); clearTradeState(); }
                    else { setTargetSymbol(entry.symbol); clearTradeState(); }
                    setOpenPicker(null);
                  }}
                  role="option"
                  type="button"
                >
                  {entry.stock ? <StockLogo stock={entry.stock} /> : entry.symbol === "ETH"
                    ? <CoinMark symbol="ETH" size={22} /> : <StockifyMark small />}
                  <span className="asset-symbol">{entry.symbol}</span>
                  <span className="asset-name">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <aside className="swap-panel" aria-label="Trade Stockify or a Base tokenized stock">
      <div className="swap-leg">
        <label htmlFor="swap-amount">You pay</label>
        <div>
          <input id="swap-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); clearTradeState(); }} placeholder="0.00" value={amount} />
          {picker("source")}
        </div>
      </div>
      <button className="swap-divider" onClick={flip} title="Swap direction" type="button">
        <span aria-hidden="true">↓</span>
        <span className="sr-only">Swap the two assets</span>
      </button>
      <div className="swap-leg swap-leg-output">
        <label htmlFor="swap-target">You receive</label>
        <div className="swap-target-row">
          <output className="swap-output" htmlFor="swap-amount">{quote ? formatUnits(quote.destAmount, quote.destDecimals) : "—"}</output>
          {picker("target")}
        </div>
      </div>
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
      <button className="swap-action" disabled={isBusy || Boolean(kycUrl) || needsStockifyConfig} onClick={needsApproval ? approve : quote?.executable ? executeSwap : connectThenQuote} type="button">{isBusy ? <SegmentRing filled={2} motion="spin" size={15} stroke={16} /> : null}{actionLabel}</button>
    </aside>
  );
}
