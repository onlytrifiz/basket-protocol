"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CoinMark } from "./coin-mark";
import { StockLogo } from "./stock-logo";
import { SegmentRing } from "./segment-ring";
import { ensureBase, truncateAddress, useWallet } from "./wallet";

/**
 * Buy or sell one tokenized equity.
 *
 * FOUR THINGS THIS HAS TO GET RIGHT, none of them optional:
 *
 *   DECIMALS. B20 equities carry EIGHT, USDC six, ETH eighteen. Every amount here is raw base units
 *   and the decimals travel with the token, never with the field.
 *
 *   APPROVAL. Selling an equity, or paying in USDC, moves an ERC-20 the router must be allowed to
 *   pull. The spender is Velora's `tokenTransferProxy`, which is NOT the transaction's `to` — a
 *   detail that fails silently and looks like a broken swap. Native ETH needs no approval at all.
 *
 *   POLICY. B20 transfers are gated per scope: buying makes the wallet the RECEIVER, selling makes
 *   it the SENDER. Checking the wrong one clears a wallet the transfer will then reject.
 *
 *   STALENESS. A quote is a priced route, not a promise. Past thirty seconds it is thrown away
 *   rather than submitted, because the alternative is a wallet prompt built on a dead price.
 */

const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Prices the panel before a wallet exists. Velora rejects placeholder-looking addresses, so the
 *  protocol's own vault stands in — a real address we control whose preview calldata is never sent. */
const PREVIEW_ADDRESS = process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS ?? "0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98";

const CASH = [
  { address: NATIVE_ETH, symbol: "ETH", decimals: 18 },
  { address: USDC, symbol: "USDC", decimals: 6 },
] as const;

type Quote = {
  destAmount: string;
  destDecimals: number;
  srcUsd: number;
  destUsd: number;
  gasCostUsd: number;
  spender: string | null;
  tx: { to: string; data: string; value: string };
  venues: string[];
};

type Asset = { address: string; symbol: string; name: string; decimals: number; logo?: string; domain?: string };

function toBaseUnits(value: string, decimals: number) {
  if (!/^\d*(\.\d*)?$/.test(value.trim())) throw new Error("Enter a valid amount.");
  const [whole = "0", fraction = ""] = value.trim().split(".");
  if (fraction.length > decimals) throw new Error(`This asset supports up to ${decimals} decimals.`);
  const raw = `${whole || "0"}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  if (BigInt(raw) <= 0n) throw new Error("Enter an amount greater than zero.");
  return raw;
}

function fromBaseUnits(raw: string, decimals: number, maxFractionDigits = 6) {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  return value.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}

const pad32 = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ error: "Unexpected response from the routing service." })) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "This trade could not be priced.");
  return payload;
}

export function TradeCard({
  asset,
  referencePrice,
  tradable = true,
}: {
  asset: Asset;
  referencePrice?: number | null;
  /** False when no pool holds this equity. An address is not a market, and offering a trade that
   *  cannot fill wastes a wallet prompt to tell someone what this panel already knows. */
  tradable?: boolean;
}) {
  const { account, connect, provider } = useWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [cashSymbol, setCashSymbol] = useState<"ETH" | "USDC">("ETH");
  const [amount, setAmount] = useState("0.05");
  const [quote, setQuote] = useState<Quote>();
  const [quoteAt, setQuoteAt] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [balance, setBalance] = useState<string>();
  const [needsApproval, setNeedsApproval] = useState(false);
  const token = useRef(0);

  const cash = CASH.find((c) => c.symbol === cashSymbol) ?? CASH[0];
  const pay = side === "buy" ? cash : { address: asset.address, symbol: asset.symbol, decimals: asset.decimals };
  const receive = side === "buy" ? { address: asset.address, symbol: asset.symbol, decimals: asset.decimals } : cash;

  const reset = useCallback(() => {
    setQuote(undefined); setQuoteAt(0); setNotice(undefined); setBlocked(false); setNeedsApproval(false);
  }, []);

  /** One `eth_call` through the connected wallet — no extra RPC dependency for a two-word answer. */
  const ethCall = useCallback(async (to: string, data: string) => {
    const result = await provider().request({ method: "eth_call", params: [{ to, data }, "latest"] });
    return typeof result === "string" ? result : "0x0";
  }, [provider]);

  // What the wallet actually holds, so "insufficient balance" is caught here rather than by a
  // reverted transaction the user has already paid gas to discover.
  useEffect(() => {
    if (!account) { setBalance(undefined); return; }
    let cancelled = false;
    (async () => {
      try {
        const raw = pay.address === NATIVE_ETH
          ? await provider().request({ method: "eth_getBalance", params: [account, "latest"] }) as string
          : await ethCall(pay.address, "0x70a08231" + pad32(account));
        if (!cancelled) setBalance(BigInt(raw || "0x0").toString());
      } catch {
        if (!cancelled) setBalance(undefined);
      }
    })();
    return () => { cancelled = true; };
  }, [account, pay.address, provider, ethCall]);

  const requestQuote = useCallback(async (swapper?: string) => {
    if (!tradable) return;
    let raw: string;
    try { raw = toBaseUnits(amount, pay.decimals); }
    catch (error) { reset(); setNotice(error instanceof Error ? error.message : undefined); return; }

    // Only the newest request may write state: typing fires several and they can land out of order.
    const ticket = ++token.current;
    const wallet = swapper ?? account;
    setIsBusy(true);
    try {
      if (wallet) {
        // Buying makes the wallet the receiver of the equity; selling makes it the sender.
        const permission = await postJson<{ allowed?: boolean }>("/api/b20/policy", {
          token: asset.address,
          walletAddress: wallet,
          scope: side === "buy" ? "receiver" : "sender",
        });
        if (ticket !== token.current) return;
        if (permission.allowed === false) {
          setBlocked(true);
          setNotice("This equity's transfer policy does not currently authorise this wallet.");
          return;
        }
      }

      const next = await postJson<Quote>("/api/velora/swap", {
        amount: raw,
        srcToken: pay.address,
        destToken: receive.address,
        swapper: wallet ?? PREVIEW_ADDRESS,
      });
      if (ticket !== token.current) return;

      setBlocked(false);
      setQuote(next);
      setQuoteAt(Date.now());
      // Named venues were the wrong answer to "is this a good fill?". Nobody buying a share needs to
      // know it cleared on aerodromeslipstreamfactory3; they need to know the aggregator looked and
      // this was the best route it found. `notice` is left for problems only.
      setNotice(undefined);

      if (wallet && next.spender) {
        const allowance = BigInt(await ethCall(pay.address, "0xdd62ed3e" + pad32(wallet) + pad32(next.spender)));
        if (ticket === token.current) setNeedsApproval(allowance < BigInt(raw));
      } else {
        setNeedsApproval(false);
      }
    } catch (error) {
      if (ticket !== token.current) return;
      setQuote(undefined);
      setNotice(error instanceof Error ? error.message : "Unable to price this trade.");
    } finally {
      if (ticket === token.current) setIsBusy(false);
    }
  }, [account, amount, asset.address, ethCall, pay.address, pay.decimals, receive.address, reset, side, tradable]);

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
       * Exactly what this trade spends, not `2^256-1`.
       *
       * An unlimited approval to Velora's transfer proxy is a standing right to move this wallet's
       * equity, granted once and outliving the trade, the quote and the session. The route is a
       * `SELL` for precisely `raw`, so approving more buys nothing — it only trades a second
       * signature on a larger order for a permanent allowance on every order that never happens.
       */
      const exact = BigInt(toBaseUnits(amount, pay.decimals));
      await provider().request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: pay.address, data: "0x095ea7b3" + pad32(quote.spender) + pad32(exact.toString(16)) }],
      });
      setNeedsApproval(false);
      setNotice("Approval submitted. Confirm the swap once it has been mined.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The approval was rejected.");
    } finally {
      setIsBusy(false);
    }
  }

  async function submit() {
    if (!quote || !account) return;
    if (Date.now() - quoteAt > 30_000) {
      reset();
      setNotice("That quote has expired. Request a fresh one before confirming.");
      return;
    }
    setIsBusy(true);
    try {
      // Base calldata, so Base or nothing — see `ensureBase`. Checked here rather than trusted from
      // `connect()`, which may have run an hour and several network switches ago.
      await ensureBase(provider());
      const hash = await provider().request({
        method: "eth_sendTransaction",
        params: [{
          from: account,
          to: quote.tx.to,
          data: quote.tx.data,
          value: `0x${BigInt(quote.tx.value || "0").toString(16)}`,
        }],
      });
      setNotice(`Submitted: ${typeof hash === "string" ? truncateAddress(hash) : "check your wallet"}.`);
      setQuote(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The wallet could not submit this trade.");
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

  const insufficient = useMemo(() => {
    if (!balance) return false;
    try { return BigInt(balance) < BigInt(toBaseUnits(amount, pay.decimals)); } catch { return false; }
  }, [balance, amount, pay.decimals]);

  /**
   * What a share actually costs (or fetches) through this route, next to the real share price.
   *
   * THE TWO DIRECTIONS ARE NOT SYMMETRIC. Buying: you spend `srcUsd` and receive `destAmount`
   * shares, so the price paid is spend ÷ shares. Selling: you give up the shares you typed and
   * receive `destUsd`, so the price realised is proceeds ÷ shares. An earlier version used `srcUsd`
   * for both, which on a sale reported Velora's mark on the INPUT rather than the executable
   * proceeds — 1 NVDAc showed as +1.02% against the share when the route actually paid +0.25%.
   * Flattering, and wrong in the direction that costs the user money.
   */
  const soldShares = useMemo(() => {
    if (side !== "sell") return 0;
    try { return Number(toBaseUnits(amount, pay.decimals)) / 10 ** pay.decimals; } catch { return 0; }
  }, [amount, pay.decimals, side]);

  const executionPrice = !quote ? null
    : side === "buy"
      ? (quote.srcUsd && quote.destAmount
          ? quote.srcUsd / (Number(BigInt(quote.destAmount)) / 10 ** quote.destDecimals)
          : null)
      : (quote.destUsd && soldShares ? quote.destUsd / soldShares : null);

  const slip = executionPrice && referencePrice ? ((executionPrice - referencePrice) / referencePrice) * 100 : null;
  // Paying above the share price is a cost; being paid above it is a gain. Same number, opposite
  // meaning, so the colour follows the side rather than the sign.
  const slipIsGood = slip === null ? null : side === "buy" ? slip < 0 : slip > 0;

  const action = !tradable ? "No market yet"
    : !account ? "Connect wallet"
    : isBusy ? "Working…"
    : blocked ? "Not authorised"
    : insufficient ? `Not enough ${pay.symbol}`
    : needsApproval ? `Approve ${pay.symbol}`
    : quote ? "Confirm in wallet"
    : "Get quote";

  return (
    <aside className="trade-card" aria-label={`Trade ${asset.symbol}`}>
      <div className="trade-sides" role="tablist">
        <button aria-selected={side === "buy"} className={side === "buy" ? "is-active" : undefined}
          onClick={() => { setSide("buy"); setAmount("0.05"); reset(); }} role="tab" type="button">Buy</button>
        <button aria-selected={side === "sell"} className={side === "sell" ? "is-active" : undefined}
          onClick={() => { setSide("sell"); setAmount("1"); reset(); }} role="tab" type="button">Sell</button>
      </div>

      <div className="trade-leg">
        <label htmlFor="trade-amount">You pay</label>
        <div className="trade-leg-body">
          <input
            id="trade-amount" inputMode="decimal" placeholder="0.00" value={amount}
            onChange={(event) => { setAmount(event.target.value); reset(); }}
          />
          {side === "buy" ? (
            <span className="trade-cash">
              <CoinMark symbol={cashSymbol} />
              <select aria-label="Pay with" onChange={(event) => { setCashSymbol(event.target.value as "ETH" | "USDC"); reset(); }} value={cashSymbol}>
                {CASH.map((c) => <option key={c.symbol} value={c.symbol}>{c.symbol}</option>)}
              </select>
            </span>
          ) : (
            <span className="trade-fixed"><StockLogo stock={asset} logo={asset.logo} size="small" />{asset.symbol}</span>
          )}
        </div>
        {balance !== undefined && (
          <button className="trade-balance" onClick={() => { setAmount(fromBaseUnits(balance, pay.decimals, pay.decimals)); reset(); }} type="button">
            Balance {fromBaseUnits(balance, pay.decimals, 4)} {pay.symbol} · Max
          </button>
        )}
      </div>

      <div className="trade-swap" aria-hidden="true"><span>↓</span></div>

      <div className="trade-leg trade-leg-out">
        <label>You receive</label>
        <div className="trade-leg-body">
          <output>{quote ? fromBaseUnits(quote.destAmount, quote.destDecimals) : "—"}</output>
          {side === "sell" ? (
            <span className="trade-cash">
              <CoinMark symbol={cashSymbol} />
              <select aria-label="Receive" onChange={(event) => { setCashSymbol(event.target.value as "ETH" | "USDC"); reset(); }} value={cashSymbol}>
                {CASH.map((c) => <option key={c.symbol} value={c.symbol}>{c.symbol}</option>)}
              </select>
            </span>
          ) : (
            <span className="trade-fixed"><StockLogo stock={asset} logo={asset.logo} size="small" />{asset.symbol}</span>
          )}
        </div>
      </div>

      <dl className="trade-facts">
        <div><dt>{side === "buy" ? "Price paid" : "Price realised"}</dt><dd>{executionPrice ? `$${executionPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—"}</dd></div>
        <div>
          <dt>vs share price</dt>
          <dd className={slipIsGood === null ? undefined : slipIsGood ? "is-up" : "is-down"}>
            {slip === null ? "—" : `${slip >= 0 ? "+" : ""}${slip.toFixed(2)}%`}
          </dd>
        </div>
        <div><dt>Est. gas</dt><dd>{quote?.gasCostUsd ? `$${quote.gasCostUsd.toFixed(2)}` : "—"}</dd></div>
      </dl>

      {!tradable ? (
        <p className="trade-notice">
          No pool holds {asset.symbol} yet, so there is no route to price. The token is live on Base —
          this panel opens the moment liquidity does.
        </p>
      ) : notice ? (
        <p className={`trade-notice${blocked ? " is-warn" : ""}`}>{notice}</p>
      ) : quote ? (
        <p className="trade-route">
          <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
            <path d="M3.5 8.4l3 3 6-6.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Best price available
        </p>
      ) : null}

      <button
        className="trade-action"
        disabled={!tradable || isBusy || blocked || insufficient || (Boolean(account) && !quote)}
        onClick={!account ? connectThenQuote : needsApproval ? approve : submit}
        type="button"
      >
        {isBusy && <SegmentRing filled={2} motion="spin" size={15} stroke={16} />}
        {action}
      </button>

    </aside>
  );
}
