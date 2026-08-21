"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { B20_DECIMALS } from "../../lib/decimals";
import { stocks, type IndexStock } from "../../lib/stocks";
import { SegmentRing } from "./segment-ring";
import { StockifyMark } from "./site-chrome";
import type { Pool } from "../../lib/pools";
import { allowanceCall, approveCall, buyCall, estimateOut, hasRouter, ROUTER, sellCall } from "../../lib/stfyRoute";
import { CoinMark } from "./coin-mark";
import { StockLogo } from "./stock-logo";

/**
 * Raw units to a short human string, without pulling in a formatting dependency.
 *
 * Six fixed decimals suits ETH and fails a token priced at 2.4e-9 of one: selling a tenth of a STFY
 * rounded a real quote to "0". Below that threshold it switches to significant digits, so a
 * genuinely tiny output reads as tiny rather than as nothing.
 */
function formatUnits(raw: string, decimals: number) {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  if (value > 0 && value < 0.000001) return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
import { ensureBase, truncateAddress, useWallet } from "./wallet";

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

/**
 * Slippage presets, in basis points, opening at 5%.
 *
 * Not the 0.5% an AMM front-end defaults to: the STFY hook takes 300 bps in ETH on the way through,
 * so anything under about 3% rejects the very trade this card exists to make. It is a floor rather
 * than MEV protection — Base has no public mempool, so the sandwich this guards against elsewhere
 * cannot be built here — but a thin pool still moves between quote and signature.
 */
const SLIPPAGE_PRESETS = [500, 1000, 1500] as const;
/** Velora's native-asset sentinel. Paying in ETH needs no wrap and no approval. */
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const stockifyAddress = process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS ?? "";
/** Pair quote symbols whose `priceNative` is a price in ETH — the unit `estimateOut` assumes. */
const ETH_QUOTED = new Set(["ETH", "WETH"]);

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
    // Straight from `lib/stocks`, which is what entitles this to the constant rather than a read:
    // the panel only ever offers assets from the seed list. See `lib/decimals`.
    ...stocks.filter((stock) => stock.inIndex)
      .map((stock) => ({ address: stock.address, name: stock.name, stock, symbol: stock.symbol, decimals: B20_DECIMALS })),
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
  const [slippageBps, setSlippageBps] = useState<number>(SLIPPAGE_PRESETS[0]);
  /** The STFY pool, read once — the direct route prices itself from its mid price. */
  const [stfyPool, setStfyPool] = useState<Pool | null>(null);
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
  /**
   * ETH<->STFY does not go through the aggregator.
   *
   * No aggregator will route a pool whose hook is not on its allowlist, and this one's never will be
   * while it is unreviewed — Velora answers "no routes with enough liquidity" for a pair DexScreener
   * indexes with real depth. `StockifyRouter` calls the manager directly instead.
   */
  const isDirect = source.symbol === "STFY" || target.symbol === "STFY";
  /**
   * Two separate ways STFY can be unconfigured, and they used to fail identically.
   *
   * `NEXT_PUBLIC_*` values are inlined at BUILD time, so setting one in a host's dashboard does
   * nothing until the next deploy — and the two variables can easily end up in different states.
   * That happened in production: the router address made it into the bundle and the token address
   * did not, so the panel silently skipped the price fetch and blamed the pool for having no price.
   * Each missing piece now says which one it is.
   */
  const hasToken = isConfiguredAddress(stockifyAddress);
  const needsStockifyConfig = isDirect && (!hasRouter || !hasToken);

  /** Swap the legs. Picking the asset already on the other side flips rather than duplicating it. */
  function flip() {
    // An amount sized for ETH is meaningless for a token worth 2.4e-9 of one, so the field resets to
    // something the new pay asset can plausibly be spent in.
    const next = targetSymbol;
    setSourceSymbol(next);
    setTargetSymbol(sourceSymbol);
    setAmount(next === "ETH" ? "0.10" : next === "STFY" ? "1000000" : "1");
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
      if (isDirect) {
        const out = estimateOut(BigInt(raw), source.symbol === "STFY" ? "sell" : "buy", stfyPool);
        if (token !== quoteToken.current) return;
        if (out === null) {
          setQuote(undefined);
          setNotice("The STFY pool has no readable price yet.");
          return;
        }
        // `minOut` is a floor, not MEV protection — Base has no public mempool. It only stops a
        // badly mispriced call from filling, so it sits well below the estimate.
        const minOut = (out * BigInt(10_000 - slippageBps)) / 10_000n;
        setQuote({
          destAmount: out.toString(),
          destDecimals: target.decimals,
          executable: Boolean(forWallet),
          spender: source.symbol === "STFY" ? ROUTER : null,
          tx: source.symbol === "STFY"
            ? { ...sellCall(BigInt(raw), minOut), value: "0" }
            : { ...buyCall(minOut), value: raw },
          venues: [],
        });
        setQuoteAt(Date.now());
        setNotice(undefined);

        if (forWallet && source.symbol === "STFY") {
          const allowance = await provider().request({
            method: "eth_call",
            params: [allowanceCall(source.address, forWallet), "latest"],
          });
          if (token === quoteToken.current) {
            setNeedsApproval(BigInt(typeof allowance === "string" && allowance !== "0x" ? allowance : "0x0") < BigInt(raw));
          }
        } else {
          setNeedsApproval(false);
        }
        return;
      }

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
        slippageBps,
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
    // `stfyPool` and `isDirect` belong here: the pool arrives AFTER the first quote attempt, and
    // without them the callback kept its stale null and the panel stayed on "no readable price"
    // until the user happened to type.
  }, [account, amount, isDirect, needsStockifyConfig, policyLeg, provider, slippageBps, source, stfyPool, target]);

  /**
   * The ETH pool specifically, not merely the deepest one.
   *
   * `estimateOut` reads `priceNative`, which is the price in the PAIR'S OWN QUOTE TOKEN, and the
   * number it produces becomes `minOut` on a real transaction. `best` is whichever pool holds the
   * most liquidity — today that is the only pool STFY has, so the two coincide; the day a deeper
   * USDC pair exists they stop coinciding silently, and a floor computed in dollars against a trade
   * settled in ether is not a floor at all. Asking for `full=1` and picking the ETH pair by name
   * costs one query parameter and removes the coincidence.
   */
  useEffect(() => {
    if (!isDirect || !isConfiguredAddress(stockifyAddress)) return;
    let cancelled = false;
    fetch(`/api/pools?addr=${stockifyAddress}&minLiq=0&full=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("pool unavailable"))))
      .then((body: { pools: Record<string, { best: Pool | null; pools?: Pool[] }> }) => {
        if (cancelled) return;
        const entry = body.pools?.[stockifyAddress.toLowerCase()];
        // `pools` arrives deepest first, so the first ETH pair is the deepest one.
        const candidates = entry?.pools ?? (entry?.best ? [entry.best] : []);
        setStfyPool(candidates.find((p) => ETH_QUOTED.has(p.quoteSymbol?.toUpperCase())) ?? null);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [isDirect]);

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
      await ensureBase(provider());
      /**
       * Exactly what this trade spends, on BOTH paths.
       *
       * The aggregator leg used to approve `2^256-1` while the direct leg approved the amount — same
       * card, two policies, and the unlimited one is a standing right for Velora's transfer proxy to
       * move this wallet's equity for as long as the token exists. `side: "SELL"` means the route
       * pulls precisely `raw`, so nothing is bought by approving more than that. Raising the amount
       * simply re-arms `needsApproval`, which is one extra signature on a trade the user is already
       * signing twice.
       */
      const exact = BigInt(toBaseUnits(amount, source.decimals));
      await provider().request({
        method: "eth_sendTransaction",
        params: [isDirect
          ? { from: account, ...approveCall(source.address, exact) }
          : { from: account, to: source.address, data: `0x095ea7b3${pad32(quote.spender)}${pad32(exact.toString(16))}` }],
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
      // Base calldata, so Base or nothing — see `ensureBase`. Checked here rather than trusted from
      // `connect()`, which may have run an hour and several network switches ago.
      await ensureBase(provider());
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
    ? (!hasToken ? "STFY token not configured" : "STFY router pending")
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
      <div className="swap-slippage">
        <span>Max slippage</span>
        <div>
          {SLIPPAGE_PRESETS.map((bps) => (
            <button
              className={bps === slippageBps ? "is-active" : undefined}
              key={bps}
              onClick={() => { setSlippageBps(bps); clearTradeState(); }}
              type="button"
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {needsStockifyConfig ? (
        <p className="swap-notice">
          {!hasToken
            ? "The STFY token address is missing from this build. NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS is read at build time, so it needs a redeploy after being set."
            : "The STFY router address is missing from this build. It is read at build time, so it needs a redeploy after being set."}
        </p>
      ) : notice ? (
        <p className={`swap-notice${quote ? " is-ready" : ""}`}>{notice}</p>
      ) : quote && !isDirect ? (
        // Only on the aggregator path, where something really was compared. The direct route has one
        // venue, so it has nothing to announce.
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
