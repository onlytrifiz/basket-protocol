"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PayTarget } from "../../../lib/shop/settlement";
import { TokenPicker, type PayGroupView } from "./token-picker";
import { ensureBase, truncateAddress, useWallet, type Eip1193Provider } from "../wallet";

/**
 * How an order gets paid.
 *
 * Everything visible here is denominated in what the buyer holds. What the
 * supplier settles in is deliberately absent — it is a stablecoin on this same
 * chain, and naming it would tell every visitor they could go and do this
 * upstream themselves.
 *
 * The transaction comes from `/api/shop/pay` already checked, and the buyer
 * only ever presses one button. Nothing here re-derives an amount or an
 * address: what is signed is the calldata the server verified names the order's
 * own deposit address, which is the single thing standing between a payment and
 * the failure that looks exactly like success.
 *
 * The wallet is the site's own — the same injected connection the swap panel
 * uses — so there is one Connect button on this site rather than two that
 * cannot see each other.
 */

const ZERO = BigInt(0);
const ERC20_BALANCE = "0x70a08231"; // balanceOf(address)
const ERC20_ALLOWANCE = "0xdd62ed3e"; // allowance(address,address)
const ERC20_APPROVE = "0x095ea7b3"; // approve(address,uint256)
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const pad = (value: string | bigint) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, ""))
    .toLowerCase()
    .padStart(64, "0");

type Step = {
  kind: "sell" | "pay";
  label: string;
  to: string;
  data: string;
  value: string;
  /** Who has to be approved to pull the input. Null when there is nothing to pull. */
  spender: string | null;
  /** The asset the approval goes on. Never the step's `to`, which is a router
   *  or an aggregator entry point — approving that is a signature that does
   *  nothing, followed by a payment that fails. Named by the server so this
   *  file never has to infer it. */
  spendToken: string;
  spendRaw: string;
  /** Set on a step that must be re-priced after the one before it lands. */
  repriceWith?: string;
};

type Quote = {
  rail: "direct" | "swap" | "router";
  symbol: string;
  decimals: number;
  /** What the buyer gives up, already rounded for reading. */
  sendAmount: string;
  /** The most the payment can pull — what a balance and an approval must cover. */
  spendMaxRaw: string;
  /** What actually lands on the order. At or above `required` by construction. */
  delivers: number;
  required: number;
  costPct: number | null;
  venues: string[];
  steps: Step[];
};

type Phase =
  | { name: "idle" }
  | { name: "pricing" }
  | { name: "ready" }
  | { name: "paying"; message: string }
  | { name: "sent" }
  | { name: "failed"; message: string };

/**
 * What went wrong, in words a buyer can act on.
 *
 * A wallet's own text is written for whoever integrated it. Each of these is a
 * failure that actually happens here, and each has a next step.
 */
function humanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/user rejected|user denied|rejected the request|4001/i.test(raw)) {
    return "You cancelled this in your wallet. Nothing was sent.";
  }
  if (/insufficient funds|exceeds balance|transfer amount exceeds/i.test(raw)) {
    return "Not enough in this wallet to cover the amount and the gas.";
  }
  if (/slippage|InsufficientAmountOut|insufficient output|STF|TRANSFER_FROM_FAILED/i.test(raw)) {
    return "The price moved while you were confirming. Press Pay again — it reprices before it asks.";
  }
  if (/reverted|execution failed/i.test(raw)) {
    return "The transaction was rejected by the contract. Press Pay again to price it fresh.";
  }
  return raw.split("\n")[0].slice(0, 180) || "The payment did not go through.";
}

/**
 * Waits for a transaction to actually be mined, and to have succeeded.
 *
 * Not optional here the way it is on a swap panel: these steps depend on each
 * other. Sending the second before the first has landed spends ETH the sale has
 * not produced yet, and treating a reverted transaction as done would leave a
 * buyer told their order was paid when nothing moved. A receipt with status 0
 * is a failure, not a result.
 */
async function waitForReceipt(provider: Eip1193Provider, hash: string): Promise<void> {
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status && BigInt(receipt.status) === ZERO) {
        throw new Error("The transaction reverted on chain.");
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error("This transaction is taking unusually long to confirm. Check your wallet.");
}

export function PayPanel({
  target,
  groups,
  onSent,
  onPayer,
}: {
  target: PayTarget;
  groups: PayGroupView[];
  /** Fired once the payment is on-chain, not once the order is settled. */
  onSent?: () => void;
  /** The wallet about to be charged. Reported before signing, not after: a
   *  payment that fails halfway is exactly the one that needs a refund path. */
  onPayer?: (address: string) => void;
}) {
  const { account, connect, isConnecting, disconnect, provider } = useWallet();

  const all = groups.flatMap((g) => g.tokens);
  /**
   * Empty until the buyer picks. Preselecting would decide, on their behalf,
   * which of their assets gets sold — so the button below stays disabled and
   * says what it is waiting for.
   */
  const [token, setToken] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [walletError, setWalletError] = useState<string | null>(null);

  /** Set once the buyer signs, freezing the quote under them. */
  const committed = useRef(false);

  // `account` is the buyer's wallet; `address` is the order's. Naming them apart
  // matters here — conflating the two is precisely the bug that pays a payment
  // back to the person who made it.
  const { address: toAddress, required } = target;

  const selected = all.find((t) => t.address.toLowerCase() === token.toLowerCase());

  /* ── balances ───────────────────────────────────────────────────────────── */

  /**
   * What this wallet actually holds, of the things it can pay with.
   *
   * Read rather than assumed because it answers the question the picker is
   * really asking. It is also the only honest way to choose a default: opening
   * on an asset the buyer has none of makes them work before they can pay.
   */
  useEffect(() => {
    if (!account) {
      setBalances({});
      return;
    }
    let cancelled = false;
    const injected = (() => {
      try {
        return provider();
      } catch {
        return null;
      }
    })();
    if (!injected) return;

    Promise.all(
      all.map(async (t) => {
        try {
          const raw =
            t.address.toLowerCase() === NATIVE_ETH.toLowerCase()
              ? ((await injected.request({
                  method: "eth_getBalance",
                  params: [account, "latest"],
                })) as string)
              : ((await injected.request({
                  method: "eth_call",
                  params: [{ to: t.address, data: `${ERC20_BALANCE}${pad(account)}` }, "latest"],
                })) as string);
          return [t.address.toLowerCase(), raw && raw !== "0x" ? BigInt(raw) : ZERO] as const;
        } catch {
          // An unread balance is not a zero balance. Left absent, so the picker
          // shows the name rather than telling someone they hold nothing.
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, bigint> = {};
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      // Read to be SHOWN, not to choose. An earlier version moved the picker
      // onto the first asset with a balance, which is helpful right up until it
      // sells something the buyer was not looking at.
      setBalances(next);
    });

    return () => {
      cancelled = true;
    };
    // `all` is derived from a prop that does not change between renders here;
    // listing it would restart this read on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, provider]);

  /* ── pricing ────────────────────────────────────────────────────────────── */

  const fetchQuote = useCallback(
    async (forSigning = false): Promise<Quote> => {
      const query = new URLSearchParams({
        token,
        required: String(required),
        to: toAddress,
        // Previews are shared between buyers and cached; the quote that gets
        // signed is neither, because it carries this wallet's own calldata.
        ...(forSigning ? { fresh: "1" } : {}),
        ...(forSigning && account ? { payer: account } : {}),
      });
      const response = await fetch(`/api/shop/pay?${query}`);
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.reason ?? data.error ?? "Could not price this payment.");
      }
      return data as Quote;
    },
    [token, required, toAddress, account],
  );

  useEffect(() => {
    if (!token) return;
    let alive = true;

    async function price() {
      // Never repriced once the buyer commits: they are signing the quote we
      // already hold, and swapping it underneath them would invalidate it. A ref
      // rather than the phase, because reading the phase here would put it in
      // the dependency list and this effect would restart itself on every state
      // it sets.
      if (committed.current) return;
      if (document.visibilityState === "hidden") return;
      setPhase((p) => (p.name === "idle" ? { name: "pricing" } : p));
      try {
        const next = await fetchQuote();
        if (!alive) return;
        setQuote(next);
        setPhase({ name: "ready" });
      } catch (error) {
        if (!alive) return;
        setQuote(null);
        setPhase({
          name: "failed",
          message: error instanceof Error ? error.message : "Could not price this payment.",
        });
      }
    }

    void price();
    /**
     * Refreshed while the buyer reads, and only until they commit.
     *
     * This is not what keeps a payment from failing — the quote that gets signed
     * is always fetched fresh at the moment of paying, so the displayed one
     * could be an hour old without breaking anything. It is what stops the
     * amount jumping under the buyer's eyes between reading it and pressing the
     * button. The server caches previews for the same window and shares one
     * upstream call between everyone looking at the same order, so asking faster
     * would mostly re-serve the same body.
     */
    const timer = setInterval(() => void price(), 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [fetchQuote, token]);

  /* ── paying ─────────────────────────────────────────────────────────────── */

  /**
   * Clears the way for a step that has to pull an ERC-20, and answers whether
   * it had to sign anything to do it.
   *
   * SEPARATE FROM SENDING, AND CALLED BEFORE THE QUOTE THAT GETS SIGNED. Left
   * inline, an ERC-20 payment is approve-then-pay, and the pay step is built
   * from a quote taken before the approval was even shown: the buyer spends
   * twenty or thirty seconds in their wallet on the first prompt while that
   * quote ages, and the second one arrives already stale — the thin pools here
   * then revert it for insufficient output. Approving first and pricing after
   * collapses that window to seconds.
   *
   * Approved with a quarter of headroom rather than the exact figure, so the
   * re-quote asking for slightly more still fits inside it instead of demanding
   * a second signature. Bounded on purpose: an unlimited allowance is not
   * something to hand out on a buyer's behalf, least of all over a tokenized
   * equity.
   */
  const ensureAllowance = useCallback(
    async (injected: Eip1193Provider, from: string, step: Step): Promise<boolean> => {
      if (!step.spender) return false;
      const needed = BigInt(step.spendRaw);
      if (needed <= ZERO) return false;

      const current = (await injected.request({
        method: "eth_call",
        params: [
          { to: step.spendToken, data: `${ERC20_ALLOWANCE}${pad(from)}${pad(step.spender)}` },
          "latest",
        ],
      })) as string;
      const allowance = current && current !== "0x" ? BigInt(current) : ZERO;
      if (allowance >= needed) return false;

      setPhase({ name: "paying", message: `Approve ${quote?.symbol ?? "the token"} first` });
      const hash = (await injected.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: step.spendToken,
            data: `${ERC20_APPROVE}${pad(step.spender)}${pad((needed * BigInt(125)) / BigInt(100))}`,
          },
        ],
      })) as string;
      await waitForReceipt(injected, hash);
      return true;
    },
    [quote?.symbol],
  );

  const send = useCallback(
    async (injected: Eip1193Provider, from: string, step: Step) => {
      // Checked again even though the approvals ran first: a re-priced step can
      // ask for more than the one it replaced, and on the ordinary path this is
      // one `eth_call` that passes.
      await ensureAllowance(injected, from, step);

      setPhase({ name: "paying", message: "Confirm in your wallet" });
      const hash = (await injected.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: step.to,
            data: step.data,
            value: `0x${BigInt(step.value || "0").toString(16)}`,
          },
        ],
      })) as string;

      setPhase({ name: "paying", message: "Waiting for confirmation" });
      await waitForReceipt(injected, hash);
    },
    [ensureAllowance],
  );

  const pay = useCallback(async () => {
    if (!quote || !account || !selected) return;
    committed.current = true;
    setPhase({ name: "paying", message: "Preparing" });
    onPayer?.(account);

    try {
      const injected = provider();
      // Base calldata, so Base or nothing — checked here rather than trusted
      // from a `connect()` that may have run an hour and several switches ago.
      await ensureBase(injected);

      /**
       * A tokenized equity can refuse to move.
       *
       * B20 assets carry transfer policies, and selling one makes this wallet
       * the SENDER. Checked before anything is signed, because the alternative
       * is an approval paid for and then a revert nobody can read.
       */
      if (selected.isB20) {
        const response = await fetch("/api/b20/policy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: selected.address, walletAddress: account, scope: "sender" }),
        });
        const permission = await response.json().catch(() => ({}));
        if (permission?.allowed === false) {
          throw new Error(
            `${selected.symbol} requires wallet verification before it can be sold. Pay with another asset, or verify this wallet with Coinbase first.`,
          );
        }
      }

      /**
       * Allowances first, from the quote already on screen — see
       * `ensureAllowance`. Only the amount matters here and the preview's is
       * within a fraction of a percent of the final one, which the headroom
       * covers; nothing from this quote is ever signed as a payment.
       */
      for (const step of quote.steps) {
        await ensureAllowance(injected, account, step);
      }

      // Re-priced immediately before signing: the quote on screen can be twenty
      // seconds old — or a wallet round-trip older, if an approval just ran —
      // and either is enough for a thin book to move past the tolerance baked
      // into its own calldata.
      setPhase({ name: "paying", message: "Pricing" });
      let fresh = await fetchQuote(true);
      setQuote(fresh);

      const balance = balances[selected.address.toLowerCase()];
      if (balance !== undefined && balance < BigInt(fresh.spendMaxRaw)) {
        throw new Error(
          `This wallet does not hold enough ${fresh.symbol} to cover ${fresh.sendAmount}.`,
        );
      }

      for (const [index, step] of fresh.steps.entries()) {
        /**
         * A step that had to wait for the one before it is priced again now.
         *
         * The STFY sale is a whole transaction long, and the ETH leg that
         * follows it is an exact-output quote whose calldata ages the same way
         * any other does. It is sized from the sale's own floor, so the ETH is
         * provably there; what it cannot promise is that the rate has not moved
         * since, and this is where that is fixed rather than hoped over.
         */
        let live = step;
        if (step.repriceWith && index > 0) {
          setPhase({ name: "paying", message: "Pricing the second step" });
          const response = await fetch(
            `/api/shop/pay?${new URLSearchParams({
              token: step.repriceWith,
              required: String(required),
              to: toAddress,
              fresh: "1",
              payer: account,
            })}`,
          );
          const data = await response.json();
          if (!response.ok || !data.ok) {
            throw new Error(
              data.reason ??
                "The sale went through, but the order could not be priced. Your ETH is in your wallet — reload this page and pay with ETH.",
            );
          }
          live = (data as Quote).steps[0];
        }

        setPhase({ name: "paying", message: live.label });
        await send(injected, account, live);
      }

      setPhase({ name: "sent" });
      onSent?.();
    } catch (error) {
      // Unfrozen so the next poll reprices, and so a retry takes a fresh quote:
      // a stale one is exactly what it must not reuse.
      committed.current = false;
      setPhase({ name: "failed", message: humanError(error) });
    }
  }, [
    quote,
    account,
    selected,
    provider,
    fetchQuote,
    balances,
    required,
    toAddress,
    send,
    ensureAllowance,
    onPayer,
    onSent,
  ]);

  /* ── render ─────────────────────────────────────────────────────────────── */

  if (phase.name === "sent") {
    return (
      <div className="sh-panel">
        <div className="sh-send">
          {/* "Sent", not "paid". All this knows is that the payment left and
              landed; whether the order is settled is the supplier's word, and
              the tracker above is the one that has it. */}
          <p style={{ fontWeight: 700, fontSize: "0.98rem" }}>Payment sent</p>
          <p className="sh-hint">
            Waiting for the order to confirm it. This page updates by itself — usually within a
            minute.
          </p>
        </div>
      </div>
    );
  }

  const busy = phase.name === "paying";
  const twoStep = quote?.rail === "router";

  return (
    <div className="sh-panel">
      <h2>Pay for this order</h2>
      <p className="sh-sub">
        Pay from Base with the stock you were paid in, or with STFY. The amount is fixed — nothing
        to type, nothing to convert.
      </p>

      <div style={{ marginTop: 18 }}>
        <span className="sh-legend">Pay with</span>
        <TokenPicker
          groups={groups}
          value={token}
          balances={balances}
          onChange={(next) => {
            setToken(next);
            // A token change invalidates the amount on screen; showing the old
            // one beside the new symbol would name one asset and charge another.
            setQuote(null);
            setPhase({ name: "pricing" });
          }}
          disabled={busy}
        />
      </div>

      <div className="sh-send">
        <div className="k">You send</div>
        <div className="v">{quote ? `${quote.sendAmount} ${quote.symbol}` : "—"}</div>
        <div className="from">from your wallet on Base</div>

        {/* Why this costs more than the card is worth, rather than by how much.
            For STFY the reason is structural and worth stating every time —
            selling it pays the same 3% the vault collects on every trade, and
            that 3% buys stock for holders. For anything else it only comes up
            when the route is genuinely expensive, which is a thin pool and
            nothing to do with us. */}
        {twoStep ? (
          <p className="cost">
            Paying in STFY costs more than the card&apos;s face value: the sale pays the same{" "}
            <b>3% hook fee</b> as any other, and that fee buys stock for holders. It is also two
            signatures rather than one, and it sells deliberately more than the order needs so the
            second step cannot come up short — <b>whatever ETH is left over stays in your wallet</b>.
            A tokenized share costs close to nothing and takes one signature.
          </p>
        ) : (
          quote?.costPct != null &&
          quote.costPct >= 3 && (
            <p className="cost">
              Converting {quote.symbol} costs noticeably more than the card is worth — its pool is
              thin, and the price moves as it converts. A tokenized share costs close to nothing.
            </p>
          )
        )}
      </div>

      {/* Two transactions is a thing to say before someone starts, not to
          discover halfway through with a wallet already open. */}
      {twoStep && !busy && (
        <ol className="sh-howto" style={{ marginTop: 14 }}>
          {quote?.steps.map((s, i) => (
            <li key={s.kind}>
              <span className="n">{i + 1}</span>
              <span>
                <span className="t">{s.label}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {phase.name === "failed" && <p className="sh-warn">{phase.message}</p>}

      {/* The token and the amount are shown before connecting, so the buyer can
          see what this costs them without plugging a wallet in first. Only the
          action changes. */}
      {!account ? (
        <>
          <button
            type="button"
            className="button button-ink sh-cta"
            onClick={() => {
              setWalletError(null);
              connect().catch((e) =>
                setWalletError(e instanceof Error ? e.message : "Connection failed"),
              );
            }}
            disabled={isConnecting}
          >
            {isConnecting ? "Connecting…" : "Connect wallet"}
          </button>
          {/* A button that silently does nothing is worse than one that says
              why — and here the commonest reason is a browser with no wallet in
              it, which the buyer can act on. */}
          {walletError && (
            <p className="sh-bad" style={{ textAlign: "center" }}>
              {walletError}
            </p>
          )}
        </>
      ) : (
        <>
          {/* Which wallet is about to be charged, and a way out of it. Next to
              the button it affects rather than in a header: this is the last
              thing read before signing, and "wrong account" is a thing people
              notice exactly here. Locked while a payment is in flight —
              disconnecting between two steps would strand it. */}
          <div className="sh-acct">
            <span className="who">{truncateAddress(account)}</span>
            <button type="button" onClick={() => void disconnect()} disabled={busy}>
              Change wallet
            </button>
          </div>
          <button
            type="button"
            className="button button-ink sh-cta"
            onClick={() => void pay()}
            disabled={phase.name !== "ready" || !quote}
            style={{ marginTop: 8 }}
          >
            {phase.name === "paying"
              ? phase.message
              : !token
                ? "Choose what to pay with"
                : phase.name === "pricing"
                  ? "Preparing…"
                  : twoStep
                    ? "Pay in two steps"
                    : "Pay now"}
          </button>
        </>
      )}

      {busy && <p className="sh-foot-note">Keep this page open until it finishes.</p>}
      {!busy && quote && (
        <p className="sh-foot-note">
          Delivers exactly ${quote.delivers.toFixed(2)} to this order.
        </p>
      )}
    </div>
  );
}
