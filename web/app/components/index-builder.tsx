"use client";

/**
 * The index builder.
 *
 * Five steps, and the order is the argument: what the fees DO comes first, because it decides which
 * of the rest even apply — a buyback has no basket to weight. The address is shown last and shown
 * ALWAYS: it is a CREATE2 prediction, so it is real before anything is deployed and before a wallet
 * is connected, which is what lets a creator name it in a launch they have not made yet.
 *
 * Launchpad-agnostic on purpose. Nothing here knows which launchpad a coin came from — the treasury
 * asks its factory's registry at bind time — so a second one costs a `setLaunchpad` call and no
 * change to this page.
 *
 * The progress bar walks backwards. Changing a weight after reading the summary should not cost five
 * clicks forward.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { IndexStock } from "../../lib/stocks";
import { INDEX_FACTORY, LAUNCHPAD, MIN_BUY_ETH, MIN_HOLDER_COINS, indicesLive } from "../../lib/indices";
import { encodeCreateIndex, saltFor, type IndexConfig } from "../../lib/indexCalldata";
import { truncateAddress, useWallet } from "./wallet";
import { CoinMark } from "./coin-mark";
import { StockLogo } from "./stock-logo";

const ZERO = "0x0000000000000000000000000000000000000000";
/** Base WETH. The locker settles an ETH-paired launch in wrapped; the treasury quotes native. */
const WETH = "0x4200000000000000000000000000000000000006";
// From `cast sig`, not from memory — three of these were wrong when written by hand, and a wrong
// selector here reads as "the launchpad does not know your coin" rather than as a bug.
const PREDICT_SELECTOR = "0xcb193942"; // predictAddress(address,bytes32)
const INDEX_COUNT_OF = "0x1c72cafc"; // indexCountOf(address)
const LAUNCHPAD_LIST = "0x43ffc6fe"; // launchpadList()
const LAUNCHPADS = "0xf12131dd"; // launchpads(uint8)
const TOKEN_QUOTE = "0xbcd40a0c"; // tokenQuote(address) — on the launchpad's fee locker
const pad32 = (v: string | number) =>
  (typeof v === "string" ? v.replace(/^0x/, "") : v.toString(16)).toLowerCase().padStart(64, "0");
const isAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());

type Shape = "single" | "basket" | "buyback";

const SHAPES: Record<Shape, { mode: 0 | 1; title: string; blurb: string; detail: string }> = {
  single: {
    mode: 0,
    title: "One stock",
    blurb: "Every fee buys one equity and pays it to your holders.",
    detail:
      "The version that pays most often: one position means the whole fee goes into one purchase, so it clears the per-name floor sooner than a split would.",
  },
  basket: {
    mode: 0,
    title: "A basket",
    blurb: "Fees buy several equities by weight and pay them all out.",
    detail:
      "Each name accrues on its own and is bought only when its slice is worth the gas, so more names means rarer payouts — the figure below moves as you add them.",
  },
  buyback: {
    mode: 1,
    title: "Buyback and burn",
    blurb: "Every fee buys the coin back and destroys it.",
    detail:
      "No equity and no payout: supply falls instead. Nothing is handed out, so no holder list is ever read and the burn is open to anyone.",
  },
};

const INTERVALS = [
  { label: "15 minutes", seconds: 900 },
  { label: "1 hour", seconds: 3_600 },
  { label: "6 hours", seconds: 21_600 },
  { label: "1 day", seconds: 86_400 },
  { label: "1 week", seconds: 604_800 },
];

const STEPS = ["What it does", "What it buys", "The split", "How often", "Your address"];

const evenWeights = (n: number) => {
  if (n <= 0) return [];
  const each = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? 10_000 - each * (n - 1) : each));
};

export function IndexBuilder({ stocks, platformBps }: { stocks: IndexStock[]; platformBps: number }) {
  const { account, connect, provider, isConnecting } = useWallet();

  const [step, setStep] = useState(0);
  const [shape, setShape] = useState<Shape>("basket");
  const [picked, setPicked] = useState<string[]>([]);
  const [weights, setWeights] = useState<number[]>([]);
  const [creatorShareBps, setCreatorShareBps] = useState(0);
  const [interval, setInterval] = useState(3_600);
  const [search, setSearch] = useState("");

  const [predicted, setPredicted] = useState<string | null>(null);
  const [salt, setSalt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The asset the coin's fees will arrive in — and the field that used to be hardcoded to ETH.
   *
   * `bind()` refuses a treasury whose `quote` is not what the launchpad says the coin is paired
   * against (`QuoteMismatch`). `quote` is set at `initialize` and there is no setter, so getting it
   * wrong does not produce a warning: it produces a treasury that can never bind, cannot be
   * reconfigured, and whose fee stream has to be pointed somewhere else entirely. That is what
   * happened to the first index created here — an AAPL-paired launch against a treasury quoting ETH.
   */
  const [quote, setQuote] = useState<string>(ZERO);
  /** Optional: an already-launched coin, used to READ the pairing instead of asking for it. */
  const [coinInput, setCoinInput] = useState("");
  const [quoteResolved, setQuoteResolved] = useState<"idle" | "looking" | "found" | "unknown">("idle");

  const isBuyback = shape === "buyback";
  /** How the chosen pairing reads: "ETH", a ticker, or the raw address for something unlisted. */
  const quoteLabel =
    quote === ZERO
      ? "ETH"
      : stocks.find((s) => s.address.toLowerCase() === quote.toLowerCase())?.symbol
        ?? `${quote.slice(0, 8)}…`;
  /** The basket holds the pairing itself — the `allocate()` path, not a swap. */
  const selfPicked = quote !== ZERO && picked.some((a) => a.toLowerCase() === quote.toLowerCase());
  const maxNames = shape === "single" ? 1 : 12;
  const total = weights.reduce((a, b) => a + b, 0);
  const rest = 10_000 - platformBps;
  const creatorCut = Math.round((rest * creatorShareBps) / 10_000);
  const holderCut = rest - creatorCut;
  const floor = isBuyback ? MIN_BUY_ETH : MIN_BUY_ETH * Math.max(1, picked.length);

  const call = useCallback(
    async (to: string, data: string) => {
      const result = await provider().request({ method: "eth_call", params: [{ to, data }, "latest"] });
      return typeof result === "string" ? result : "0x";
    },
    [provider]
  );

  /**
   * The address the factory would produce for this wallet — at the first nonce still free.
   *
   * `create2` at an address that already holds code returns zero and the factory reverts
   * `CloneFailed`, so a fixed salt is one index per wallet for good. Starting from
   * `indexCountOf(account)` lands on a free slot immediately in the ordinary case, and the loop
   * covers the rest: indexes created by an earlier version of this page, or outside it entirely.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!account || !indicesLive) return setPredicted(null);
      try {
        const countHex = await call(INDEX_FACTORY, INDEX_COUNT_OF + pad32(account));
        let nonce = countHex && countHex !== "0x" ? Number(BigInt(countHex)) : 0;

        for (let tries = 0; tries < 16; tries++) {
          const s = await saltFor(account, nonce);
          const result = await call(INDEX_FACTORY, PREDICT_SELECTOR + pad32(account) + pad32(s));
          const address = `0x${result.slice(-40)}`;
          const code = (await provider().request({
            method: "eth_getCode",
            params: [address, "latest"],
          })) as string;
          if (cancelled) return;
          if (code === "0x" || code === "0x0") {
            setSalt(s);
            setPredicted(address);
            return;
          }
          nonce += 1;
        }
        if (!cancelled) setPredicted(null);
      } catch {
        if (!cancelled) setPredicted(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, call, provider]);

  /**
   * Read the pairing off the launchpad rather than asking the creator to remember it.
   *
   * This is the same question `bind()` asks, against the same registries, so an answer here cannot
   * disagree with the answer that decides whether the treasury works. The factory's launchpad list
   * is walked in order — exactly as `bind()` walks it — and the first registry that names an asset
   * for this coin settles it.
   *
   * A coin nobody recognises leaves the manual choice in place: an unlaunched coin has no pairing to
   * read yet, and that is the ordinary case for someone reserving an address before their launch.
   */
  useEffect(() => {
    const entered = coinInput.trim();
    if (!isAddress(entered) || !indicesLive || !account) {
      setQuoteResolved("idle");
      return;
    }
    let cancelled = false;
    setQuoteResolved("looking");
    (async () => {
      try {
        const listHex = await call(INDEX_FACTORY, LAUNCHPAD_LIST);
        const body = listHex.replace(/^0x/, "");
        const n = body.length >= 128 ? Number(BigInt(`0x${body.slice(64, 128)}`)) : 0;
        const ids = Array.from({ length: n }, (_, i) =>
          Number(BigInt(`0x${body.slice(128 + i * 64, 128 + (i + 1) * 64)}`))
        );

        for (const id of ids) {
          const padHex = await call(INDEX_FACTORY, LAUNCHPADS + pad32(id));
          const w = padHex.replace(/^0x/, "");
          if (w.length < 192) continue;
          const registry = `0x${w.slice(24, 64)}`;
          const enabled = BigInt(`0x${w.slice(128, 192)}`) !== 0n;
          if (!enabled || !isAddress(registry) || BigInt(registry) === 0n) continue;

          const quoteHex = await call(registry, TOKEN_QUOTE + pad32(entered));
          const paired = quoteHex.length >= 66 ? `0x${quoteHex.slice(-40)}` : ZERO;
          if (BigInt(paired) === 0n) continue;
          if (cancelled) return;
          // WETH and native are one asset to the treasury: it unwraps what the locker pays.
          setQuote(paired.toLowerCase() === WETH.toLowerCase() ? ZERO : paired);
          setQuoteResolved("found");
          return;
        }
        if (!cancelled) setQuoteResolved("unknown");
      } catch {
        if (!cancelled) setQuoteResolved("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, call, coinInput]);

  const toggle = useCallback(
    (address: string) => {
      setPicked((prev) => {
        const without = prev.filter((a) => a !== address);
        const next =
          without.length !== prev.length
            ? without
            : shape === "single"
              ? [address]
              : prev.length >= maxNames
                ? prev
                : [...prev, address];
        setWeights(evenWeights(next.length));
        return next;
      });
    },
    [maxNames, shape]
  );

  const canCreate =
    indicesLive && !!account && !!predicted && !!salt && (isBuyback || (picked.length > 0 && total === 10_000));

  async function create() {
    if (!account || !predicted || !salt) return;
    setBusy(true);
    setError(null);
    try {
      const cfg: IndexConfig = {
        owner: account,
        creator: account,
        // Native when the coin is paired against WETH; the treasury treats ether and wrapped as one
        // asset. A coin paired against an equity states that equity here — read off the launchpad
        // when the coin already exists, chosen above when it does not.
        quote,
        basket: isBuyback ? [] : picked,
        weights: isBuyback ? [] : weights,
        interval,
        creatorShareBps,
        mode: SHAPES[shape].mode,
        // Bound later, by the keeper, once the launch actually points its fees here. Naming it now
        // would bind a coin that does not pay this treasury yet, and `coin` is write-once.
        coin: ZERO,
      };
      const hash = (await provider().request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: INDEX_FACTORY, data: encodeCreateIndex(cfg, salt, predicted) }],
      })) as string;
      setTxHash(hash);
    } catch (e) {
      const message = (e as { message?: string })?.message ?? "The wallet refused the transaction.";
      setError(message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(
    () =>
      stocks.filter(
        (s) =>
          !search ||
          s.symbol.toLowerCase().includes(search.toLowerCase()) ||
          s.name.toLowerCase().includes(search.toLowerCase())
      ),
    [search, stocks]
  );

  if (!indicesLive) {
    return (
      <p className="detail-empty">
        The index factory is not deployed on this network, so nothing can be created. No address is
        invented here.
      </p>
    );
  }

  return (
    <div className="builder">
      {/* Every step already passed is a button, not a label. */}
      <nav className="builder-steps" aria-label="Steps">
        {STEPS.map((label, i) => (
          <button
            className={i === step ? "is-current" : i < step ? "is-done" : undefined}
            disabled={i > step}
            key={label}
            onClick={() => setStep(i)}
            type="button"
          >
            <b>{i + 1}</b> {label}
          </button>
        ))}
      </nav>

      {step === 0 && (
        <div className="builder-panel">
          <div className="builder-choices">
            {(Object.keys(SHAPES) as Shape[]).map((key) => (
              <button
                className={shape === key ? "is-picked" : undefined}
                key={key}
                onClick={() => {
                  setShape(key);
                  if (key === "single" && picked.length > 1) {
                    setPicked(picked.slice(0, 1));
                    setWeights([10_000]);
                  }
                }}
                type="button"
              >
                <strong>{SHAPES[key].title}</strong>
                <span>{SHAPES[key].blurb}</span>
                <small>{SHAPES[key].detail}</small>
              </button>
            ))}
          </div>
          {/* True in all three, so it is said once here rather than three times below. */}
          <p className="builder-note">
            Whichever you pick, the part of the fee that arrives <em>as your own coin</em> is always
            burned. A treasury has no use for it, and holding it would make your launch a holder of
            itself.
          </p>
        </div>
      )}

      {step === 1 && (
        <div className="builder-panel">
          {/* WHAT THE FEES ARRIVE IN. Asked before what to buy with them, because it decides
              whether there is anything to buy at all: when the pairing IS the name you want, the
              treasury sets the asset aside instead of selling it to itself. */}
          <div className="builder-quote">
            <label htmlFor="builder-coin">Your coin, if it has already launched</label>
            <input
              className="builder-search"
              id="builder-coin"
              onChange={(e) => setCoinInput(e.target.value)}
              placeholder="0x… — optional, we read the pairing from the launchpad"
              spellCheck={false}
              value={coinInput}
            />
            {quoteResolved === "looking" && <p className="builder-note">Asking the launchpad…</p>}
            {quoteResolved === "found" && (
              <p className="builder-ok">
                Paired against <strong>{quoteLabel}</strong>, read from the launchpad. That is what
                your fees arrive in, so that is what this index is quoted in.
              </p>
            )}
            {quoteResolved === "unknown" && (
              <p className="builder-note">
                No launchpad recognises that address yet. If your coin is not launched, that is
                expected — pick what you will pair it against below.
              </p>
            )}

            {quoteResolved !== "found" && (
              <>
                <span className="builder-quote-label">Paired against</span>
                <div className="builder-grid is-tight">
                  <button
                    className={quote === ZERO ? "is-picked" : undefined}
                    onClick={() => setQuote(ZERO)}
                    type="button"
                  >
                    <CoinMark size={22} symbol="ETH" />
                    <span>ETH</span>
                  </button>
                  {stocks.map((s) => (
                    <button
                      className={quote.toLowerCase() === s.address.toLowerCase() ? "is-picked" : undefined}
                      key={`q-${s.address}`}
                      onClick={() => setQuote(s.address)}
                      type="button"
                    >
                      <StockLogo logo={undefined} stock={{ symbol: s.symbol, domain: s.domain }} />
                      <span>{s.ticker}</span>
                    </button>
                  ))}
                </div>
                <p className="builder-note">
                  This has to match what the launchpad says, or the index can never bind — and it is
                  fixed at creation, with no way to change it afterwards.
                </p>
              </>
            )}
          </div>

          {isBuyback ? (
            <p className="builder-note">
              Nothing else to choose. A buyback index buys back the coin it collects for and destroys
              it — the target is fixed when it binds, not by configuration, so it can never be pointed
              at anything else.
            </p>
          ) : (
            <>
              <input
                className="builder-search"
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search NVDA, Apple, Coinbase…"
                value={search}
              />
              <div className="builder-grid">
                {visible.map((s) => (
                  <button
                    className={picked.includes(s.address) ? "is-picked" : undefined}
                    key={s.address}
                    onClick={() => toggle(s.address)}
                    type="button"
                  >
                    <StockLogo logo={undefined} stock={{ symbol: s.symbol, domain: s.domain }} />
                    <span>{s.ticker}</span>
                  </button>
                ))}
              </div>

              {picked.length > 0 && shape === "basket" && (
                <div className="builder-weights">
                  {picked.map((address, i) => {
                    const s = stocks.find((x) => x.address === address);
                    return (
                      <label key={address}>
                        <span>{s?.ticker}</span>
                        <input
                          max={10_000}
                          min={0}
                          onChange={(e) =>
                            setWeights((w) => w.map((v, j) => (j === i ? Number(e.target.value) : v)))
                          }
                          type="range"
                          value={weights[i] ?? 0}
                        />
                        <b>{((weights[i] ?? 0) / 100).toFixed(0)}%</b>
                      </label>
                    );
                  })}
                  <div className="builder-actions">
                    <button onClick={() => setWeights(evenWeights(picked.length))} type="button">
                      Even split
                    </button>
                    <b className={total === 10_000 ? "is-ok" : "is-off"}>{(total / 100).toFixed(0)}%</b>
                  </div>
                </div>
              )}

              {picked.length > 0 && quote === ZERO && (
                <p className="builder-note">
                  Each name is bought only when its own slice is worth the gas, so this needs about{" "}
                  <strong>{floor.toFixed(2)} ETH</strong> of fees to accumulate before it moves at
                  all. More names means rarer payouts.
                </p>
              )}

              {/* The pairing sitting in the basket is the case worth calling out: it is not a
                  mistake, it is the cheapest shape this can take. */}
              {selfPicked && (
                <p className="builder-ok">
                  {quoteLabel} is both what your fees arrive in and what you are paying out, so
                  nothing is traded for it — the treasury sets it aside and hands it over. No venue,
                  no spread, no route that can fail.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="builder-panel">
          <input
            className="builder-range"
            max={10_000}
            min={0}
            onChange={(e) => setCreatorShareBps(Number(e.target.value))}
            step={100}
            type="range"
            value={creatorShareBps}
          />
          <div className="builder-split">
            <div>
              <span>Protocol</span>
              <strong>{(platformBps / 100).toFixed(0)}%</strong>
            </div>
            <div className="is-lit">
              <span>{isBuyback ? "Burned" : "Holders"}</span>
              <strong>{(holderCut / 100).toFixed(0)}%</strong>
            </div>
            <div>
              <span>You keep</span>
              <strong>{(creatorCut / 100).toFixed(0)}%</strong>
            </div>
          </div>
          <p className="builder-note">
            The protocol&apos;s cut comes off the top; yours is taken from what is left. What you keep
            is fenced off on-chain — a buy can never spend it, and a payout can never reach it.
          </p>
        </div>
      )}

      {step === 3 && (
        <div className="builder-panel">
          <div className="builder-choices is-tight">
            {INTERVALS.map((i) => (
              <button
                className={interval === i.seconds ? "is-picked" : undefined}
                key={i.seconds}
                onClick={() => setInterval(i.seconds)}
                type="button"
              >
                <strong>{i.label}</strong>
              </button>
            ))}
          </div>
          <p className="builder-note">
            {isBuyback
              ? "A buyback has no round to open — the burn is permissionless and happens whenever there is something to destroy. This only bounds how often the keeper works."
              : `The floor, not the schedule. A round opens no sooner than this, and only when there is something to pay. Holders under ${MIN_HOLDER_COINS.toLocaleString("en-US")} coins are skipped, and their slice stays with everyone above the line.`}
          </p>
        </div>
      )}

      {step === 4 && (
        <div className="builder-panel">
          {!account ? (
            <>
              <p className="builder-note">
                Connect a wallet to see your address. It is reserved for that wallet — the salt ties
                it to you, so nobody else can take it.
              </p>
              <button className="button button-ink" disabled={isConnecting} onClick={() => connect()} type="button">
                {isConnecting ? "Connecting…" : "Connect wallet"}
              </button>
            </>
          ) : (
            <>
              <div className="builder-address">
                <span>Your index will live at</span>
                <code>{predicted ?? "…"}</code>
                {predicted && (
                  <button onClick={() => navigator.clipboard?.writeText(predicted)} type="button">
                    Copy
                  </button>
                )}
              </div>

              <p className="builder-note">
                Create it now, then point your launch&apos;s creator fees at this address. It works in
                either order: the address exists before the contract does, so it can be named in a
                launch you have not made yet.
              </p>

              <ol className="builder-after">
                <li>
                  Create the index — one transaction, and it is yours at the address above.
                </li>
                <li>
                  Point your coin&apos;s creator fees at it, on{" "}
                  <a href={LAUNCHPAD.url} rel="noreferrer" target="_blank">{LAUNCHPAD.name}</a> or any
                  launchpad this service supports.
                </li>
                <li>
                  Nothing else. The keeper notices, binds the coin, and runs the cycle from then on.
                </li>
              </ol>

              {error && <p className="builder-error">{error}</p>}
              {txHash ? (
                <p className="builder-ok">
                  Created —{" "}
                  <a href={`https://basescan.org/tx/${txHash}`} rel="noreferrer" target="_blank">
                    view the transaction ↗
                  </a>
                </p>
              ) : (
                <button className="button button-ink" disabled={!canCreate || busy} onClick={create} type="button">
                  {busy ? "Confirm in your wallet…" : "Create index"}
                </button>
              )}

              {!canCreate && !busy && !txHash && !isBuyback && total !== 10_000 && (
                <p className="builder-note">The weights have to add up to 100% before it can be created.</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="builder-nav">
        <button disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))} type="button">
          Back
        </button>
        <button
          className="button button-ink"
          disabled={step === STEPS.length - 1}
          onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
          type="button"
        >
          Next
        </button>
      </div>

      {account && <p className="builder-who">Connected as {truncateAddress(account)}</p>}
    </div>
  );
}
