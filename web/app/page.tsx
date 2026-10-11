import Image from "next/image";
import Link from "next/link";

import { readAssets } from "../lib/b20";
import { readDecimals, toUnits } from "../lib/decimals";
import { readLedger } from "../lib/ledger";
import { countWord, shares as fmtShares, usdCompact } from "../lib/format";
import { marketBoard } from "../lib/market";
import { stockByAddress, stocks, washColor } from "../lib/stocks";
import { readVault } from "../lib/vault";
import { CountUp } from "./components/count-up";
import { IndexUniverse } from "./components/index-universe";
import { StockLogo } from "./components/stock-logo";
import { SiteFooter, SiteHeader } from "./components/site-chrome";
import { StockMarquee } from "./components/stock-marquee";
import { StockStage, type StageStock } from "./components/stock-stage";
import { SwapPanel } from "./components/swap-panel";

/**
 * The index donut is a LIVE read, so this page is rendered per request.
 *
 * `revalidate = 60` alone was not enough, and the reason is a trap worth naming. `lib/cache` wraps
 * every chain read, and when its in-process cache is warm no `fetch` runs during render — so Next's
 * static analysis sees no dynamic API and prerenders the page. Whether `/` came out static or
 * dynamic therefore depended on whether the cache happened to be warm in that build worker.
 *
 * When it came out static, the vault's answer at build time was frozen into the HTML: a build that
 * ran while the public RPC was throttled shipped "the index could not be read" for the life of the
 * deploy. /stocks and /dividends escaped only because they also call the market API directly.
 *
 * Forced, so it is a decision rather than an accident. The reads are still cached for 30-60s each,
 * so per-request rendering costs no extra RPC traffic.
 */
export const dynamic = "force-dynamic";

/* The four products, laid out as a bento rather than a row of equal cards: the protocol the site is
   named for gets the tall cell, and each cell gets the render that already stands for it elsewhere
   on the site. `tone` picks the cell's surface. */
const products = [
  {
    name: "$STFY",
    href: "/dividends",
    line: "Stock dividend protocol",
    copy: "Trading fees buy tokenized equity and push it to holders. Nothing to claim.",
    tone: "blue",
    art: "/distributions.png",
  },
  {
    name: "Indices",
    href: "/indices",
    line: "Turn token fees into a stocks basket",
    copy: "Point a launch's creator fees at an index and its holders are paid in real equity.",
    tone: "light",
    art: "/baskets.png",
  },
  {
    name: "Stocks Terminal",
    href: "/stocks",
    line: "Get info about any B20 stock",
    copy: "Supply, markets and how far each one trades from the share it represents.",
    tone: "sunken",
    art: "/stocks.png",
  },
  {
    name: "Shop",
    href: "/shop",
    line: "Spend the stock you were paid in",
    copy: "Gift cards, eSIM data and mobile top-ups across 2,000+ brands, in one transaction on Base.",
    tone: "ink",
    art: null,
  },
] as const;

/* Each step carries its own 3D mark, generated to match the site's coin renders: the STFY coin
   changing hands, the vault taking in stock, a wallet receiving it. Only the last is lit lime,
   because it is the only step where value reaches a holder. */
const mechanics = [
  { number: "01", art: "/icons/loop-trade.png", lit: false, title: "Trade STFY", copy: "The ETH / STFY v4 market is designed to collect a 3% hook fee on trading." },
  { number: "02", art: "/icons/loop-acquire.png", lit: false, title: "Acquire the index", copy: "A keeper routes 90% of each collected hook fee into the active Base B20 equity index." },
  { number: "03", art: "/icons/loop-receive.png", lit: true, title: "Receive the stocks", copy: "The dividend vault pushes each acquired asset pro-rata to eligible STFY holders." },
];

export default async function Home() {
  // The same read /dividends makes. A homepage claiming a different index from the page that
  // shows the vault would be two answers to one question.
  // Weights from the vault, marks from the tokens themselves — the same `contractURI()` icons the
  // hub uses, so a ticker Base lists tomorrow arrives correctly branded here too.
  const [vault, assets, ledger] = await Promise.all([readVault(), readAssets(), readLedger()]);
  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));

  /**
   * What each equity has actually paid out, all time — the same walk /dividends makes.
   *
   * KEYED ON THE LEDGER, NOT ON INDEX MEMBERSHIP. `setIndex` rotates names out, and a cycle that
   * bought one before it left keeps its row forever; asking "is it in the index today" would erase
   * a real distribution the moment ownership changed the set. A stock has distributed something or
   * it has not, and that is a fact about the past.
   */
  const distributedAddresses = [...new Set(ledger.cycles.flatMap((c) => c.bought.map((b) => b.address.toLowerCase())))];
  const decimals = distributedAddresses.length ? await readDecimals(distributedAddresses) : new Map<string, number>();
  const distributedByAsset = new Map<string, number>();
  for (const cycle of ledger.cycles) {
    for (const bought of cycle.bought) {
      const key = bought.address.toLowerCase();
      // An asset whose scale went unread contributes nothing rather than a number at the wrong
      // scale — the same rule every other surface in this repo follows for an unread balance.
      const units = toUnits(bought.receivedRaw, decimals.get(key) ?? null);
      if (units === null) continue;
      distributedByAsset.set(key, (distributedByAsset.get(key) ?? 0) + units);
    }
  }
  const paidTickers = distributedAddresses.map((a) => byAddress.get(a)?.ticker).filter(Boolean) as string[];
  const market = paidTickers.length ? await marketBoard(paidTickers) : { quotes: {}, series: {}, degraded: true };

  /* The same two figures the fan shows for whichever card is centred, summed instead — so the band
     keeps saying something while the carousel is away rather than going quiet. Off the map above,
     so an asset whose scale went unread is skipped once rather than twice. */
  const paidShares = [...distributedByAsset.values()].reduce((sum, units) => sum + units, 0);
  const paidValue = [...distributedByAsset].reduce((sum, [address, units]) => {
    const ticker = byAddress.get(address)?.ticker;
    const price = ticker ? market.quotes[ticker]?.price : undefined;
    return sum + (price ? units * price : 0);
  }, 0);

  /* The fan below the donut, built from the LIVE listing rather than from the seed file: a ticker
     Base lists tomorrow arrives with its own icon and its own supply, and only its colour falls
     back to the house blue. Index members lead, so the strip under the fan opens on a weight
     instead of on "not bought by the vault". */
  const weightByAddress = new Map(vault.holdings.map((h) => [h.address.toLowerCase(), h.weightBps]));
  const stageStocks: StageStock[] = assets
    .map((asset) => ({
      symbol: asset.symbol,
      /* The SEED name in preference to the chain's. `name()` returns the legal entity — "Meta
         Platforms", "Circle Internet Group" — and this card has one line for it. A listing the
         seed file does not know still falls back to whatever the token calls itself. */
      name: stockByAddress(asset.address)?.name ?? asset.name,
      domain: asset.domain,
      brand: washColor(stockByAddress(asset.address)),
      logo: asset.logo,
      weightBps: weightByAddress.get(asset.address.toLowerCase()) ?? null,
      shares: asset.shares,
      distributed: distributedByAsset.get(asset.address.toLowerCase()) ?? 0,
      distributedValue: (() => {
        const units = distributedByAsset.get(asset.address.toLowerCase());
        const price = asset.ticker ? market.quotes[asset.ticker]?.price : undefined;
        // No quote is not zero dollars. The card says "unpriced" rather than inventing a figure.
        return units && price ? units * price : null;
      })(),
    }))
    /* THE FIVE THE VAULT BUYS, PLUS COINBASE. Thirteen cards made the band a catalogue; the five
       that actually pay out are the claim the page is making, and Coinbase is on it because it is
       the issuer of every one of these tokens rather than because the vault holds it. The full
       thirteen are one section down, as a grid, which is the shape a catalogue wants. */
    .filter((stock) => stock.weightBps !== null || stock.symbol === "COINc")
    .sort((a, b) => (b.weightBps ?? -1) - (a.weightBps ?? -1));

  const slices = vault.holdings.map((h) => {
    const asset = byAddress.get(h.address.toLowerCase());
    const known = stockByAddress(h.address);
    return {
      symbol: h.symbol,
      name: h.name,
      weightBps: h.weightBps,
      // A listing this repo has no colour for still gets an arc, in the house blue.
      brand: known?.brand ?? "#7aa8ff",
      logo: asset?.logo,
      domain: asset?.domain,
    };
  });

  const hasStage = stageStocks.length > 0;

  /* What each equity has paid out so far, largest first: the receipts under the hero. Built from the
     same map the fan reads, so the strip and the centred card can never disagree. */
  const receipts = stageStocks
    .filter((stock) => stock.distributed > 0)
    .sort((a, b) => (b.distributedValue ?? 0) - (a.distributedValue ?? 0));

  return (
    <div className="site-shell">
      <SiteHeader active="home" />
      <main>
        {/* THE HERO IS THE CLAIM AND ITS EVIDENCE, nothing else. The headline runs the full rail at
            poster size, and the cards the vault buys stand under it as the subject. The swap card
            that used to share this band has its own section further down (#buy): a reader decides
            to buy after the page has said what they would be buying. */}
        <header className="hero-card hero-v2" id="overview">
          <div className="hero-v2-top">
            <p className="eyebrow">Base · B20 equity dividends</p>
            <h1 className="hero-v2-title">Hold Stockify.<br /><span>Receive stocks.</span></h1>
            <div className="hero-v2-side">
              <p className="hero-lede">Trading fees buy Base-native tokenized equities, and the vault pushes them straight to STFY holders.</p>
              <div className="hero-actions">
                <Link className="button button-ink" href="#buy">Buy STFY <span aria-hidden="true">↓</span></Link>
                <Link className="button button-ghost" href="/dividends">View the dividends</Link>
              </div>
            </div>
          </div>
          {/* The fan of the equities the vault buys, with what has actually been paid out either side
              of it. The render it replaced is still the OG image's subject, and it comes back here only
              when the listing could not be read, so the band never collapses into an empty strip. */}
          <div className={`flow-strip${hasStage ? " is-stage" : " is-render"}`}>
            {hasStage ? (
              <StockStage stocks={stageStocks} variant="band" />
            ) : (
              <>
                <Image alt="" fill priority sizes="100vw" src="/header-transparent.png" />
                <div className="stage-flanks">
                  <div className="stage-flank is-paid">
                    <span>Stocks distributed</span>
                    <strong>{paidShares > 0 ? fmtShares(paidShares) : "—"}</strong>
                    <small>{paidShares > 0 ? "to holders, all time" : "no cycle has paid yet"}</small>
                  </div>
                  <div className="stage-flank is-right">
                    <span>Distribution value</span>
                    <strong>{paidValue > 0 ? usdCompact(paidValue) : "—"}</strong>
                    <small>{paidValue > 0 ? "at current prices" : "nothing distributed"}</small>
                  </div>
                </div>
              </>
            )}
          </div>
        </header>

        {/* RECEIPTS. The total, then each equity's share of it. The figure a holder cares about most
            is what has already arrived, so it sits directly under the claim it backs. */}
        {receipts.length > 0 && (
          <section aria-label="Paid to holders so far" className="receipts wrap">
            <div className="receipts-total">
              <span>Paid to holders</span>
              <strong>{paidValue > 0 ? <CountUp format="usdCompact" value={paidValue} /> : fmtShares(paidShares)}</strong>
              <small>{paidValue > 0 ? `${fmtShares(paidShares)} shares, at current prices` : "shares, all time"}</small>
            </div>
            <ul className="receipts-list">
              {receipts.map((stock) => (
                <li key={stock.symbol}>
                  <Link href={`/stocks/${stock.symbol.toLowerCase()}`} style={{ "--brand": stock.brand } as React.CSSProperties}>
                    <StockLogo logo={stock.logo} size="small" stock={stock} />
                    <span className="receipt-name"><b>{stock.symbol}</b><small>{stock.name}</small></span>
                    <span className="receipt-figures">
                      <b>{fmtShares(stock.distributed)}</b>
                      <small>{stock.distributedValue === null ? "unpriced" : usdCompact(stock.distributedValue)}</small>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* The loop as a timeline beside its headline, not three equal cards: the steps happen in
            order, and a vertical rail says so where a row of boxes does not. */}
        <section className="section wrap loop-section" id="how">
          <div className="loop-head reveal">
            <h2>A stock dividend that starts with volume.</h2>
            <p>Stockify does not reflect another token into your wallet. The vault buys the B20 assets themselves and pushes them to holders.</p>
          </div>
          <ol className="loop-steps">
            {mechanics.map((step) => (
              <li className={`loop-step reveal${step.lit ? " is-lit" : ""}`} key={step.number}>
                <span aria-hidden="true" className="loop-art">
                  <Image alt="" height={112} sizes="112px" src={step.art} width={112} />
                </span>
                <div>
                  <span className="loop-number">{step.number}</span>
                  <h3>{step.title}</h3>
                  <p>{step.copy}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* WHERE THE SWAP CARD LIVES NOW: beside the four numbers that decide what a purchase earns,
            which is the moment a reader is actually ready to use it. */}
        <section className="buy-section" id="buy">
          <div className="buy-inner wrap">
            <div className="buy-copy reveal">
              <h2>Buy STFY.<br />Get paid in stocks.</h2>
              <p>Hold at least the eligibility threshold and every settled cycle lands in your wallet as tokenized equity.</p>
              <dl className="buy-facts">
                <div><dt>Hook fee</dt><dd>3%</dd><small>on every STFY trade</small></div>
                <div><dt>To stocks</dt><dd>90%</dd><small>of each hook fee</small></div>
                <div><dt>LP fee</dt><dd>1%</dd><small>to v4 liquidity providers</small></div>
                <div><dt>Supply</dt><dd>1B</dd><small>STFY, fixed</small></div>
              </dl>
              <Link className="text-link" href="/docs">How the protocol works <span aria-hidden="true">→</span></Link>
            </div>
            <div className="buy-swap"><SwapPanel /></div>
          </div>
        </section>

        <section className="section universe-section" id="index">
          <div className="wrap universe-split">
            <div className="universe-copy reveal">
              <p className="eyebrow">The B20 stocks universe</p>
              <h2>{countWord(stocks.length)} listed. Five in the index.</h2>
              <p>Every B20 equity Coinbase has issued on Base. The vault buys a configurable subset of them, and the index can change between cycles.</p>
              <Link className="button button-ghost" href="/stocks">Browse every stock <span>→</span></Link>
            </div>
            <div className="reveal"><IndexUniverse slices={slices} /></div>
          </div>
          <StockMarquee />
        </section>

        <section className="section wrap" id="products">
          <div className="section-head reveal">
            <h2>The hub for B20 stocks on Base.</h2>
            <p>One protocol that pays them out, one that turns any launch&apos;s fees into them, one place to look them up, and one place to spend them.</p>
          </div>
          <div className="bento">
            {products.map((product) => (
              <Link className={`bento-cell reveal is-${product.tone}`} href={product.href} key={product.name}>
                <span className="bento-text">
                  <strong className="product-name">{product.name}</strong>
                  <span className="product-line">{product.line}</span>
                  <span className="bento-copy">{product.copy}</span>
                </span>
                {product.art && (
                  <span aria-hidden="true" className="bento-art">
                    <Image alt="" fill sizes="(max-width: 760px) 80vw, 420px" src={product.art} />
                  </span>
                )}
                <b aria-hidden="true" className="bento-go">→</b>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
