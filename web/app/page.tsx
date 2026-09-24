import Image from "next/image";
import Link from "next/link";

import { readAssets } from "../lib/b20";
import { readDecimals, toUnits } from "../lib/decimals";
import { readLedger } from "../lib/ledger";
import { shares as fmtShares, usdCompact } from "../lib/format";
import { marketBoard } from "../lib/market";
import { stockByAddress, washColor } from "../lib/stocks";
import { readVault } from "../lib/vault";
import { IndexUniverse } from "./components/index-universe";
import { RingMarker } from "./components/segment-ring";
import { SiteFooter, SiteHeader } from "./components/site-chrome";
import { StockGrid } from "./components/stock-grid";
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

/**
 * TEMPORARY: the hero band is showing the render again instead of the card fan.
 *
 * Nothing is deleted. `StockStage` and everything it needs are still here and still built, and the
 * band still gets the same two figures either way — flip this back to `true` and the fan returns
 * exactly as it was.
 */
const HERO_STAGE = false;

/* `filled` advances the ring across the loop; only the final step is a payout,
   so it is the only one allowed to light a segment lime. */
const products = [
  {
    name: "$STFY",
    href: "/dividends",
    line: "Stock dividend protocol",
    copy: "Trading fees buy tokenized equity and push it to holders. Nothing to claim.",
  },
  {
    name: "Indices",
    href: "/indices",
    line: "Turn token fees into a stocks basket",
    copy: "Point a launch's creator fees at an index and its holders are paid in real equity.",
  },
  {
    name: "Stocks Terminal",
    href: "/stocks",
    line: "Get info about any B20 stock",
    copy: "Supply, markets and how far each one trades from the share it represents.",
  },
  {
    name: "Shop",
    href: "/shop",
    line: "Spend the stock you were paid in",
    copy: "Gift cards, eSIM data and mobile top-ups across 2,000+ brands, in one transaction on Base.",
  },
] as const;

const mechanics = [
  { number: "01", filled: 3, lit: false, title: "Trade STFY", copy: "The ETH / STFY v4 market is designed to collect a 3% hook fee on trading." },
  { number: "02", filled: 6, lit: false, title: "Acquire the index", copy: "A keeper routes 90% of each collected hook fee into the active Base B20 equity index." },
  { number: "03", filled: 8, lit: true, title: "Receive the stocks", copy: "The dividend vault pushes each acquired asset pro-rata to eligible STFY holders." },
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

  return (
    <div className="site-shell">
      <SiteHeader active="home" />
      <main>
        <header className="hero-card" id="overview">
          <div className="hero-inner">
            <div className="hero-copy">
              <p className="eyebrow">BASE · B20 EQUITY DIVIDENDS</p>
              <h1>Hold Stockify.<br /><span>Receive stocks.</span></h1>
              <p className="hero-lede">Stockify routes trading fees into Base-native tokenized equities, then distributes the acquired assets to qualifying STFY holders.</p>
              <div className="hero-actions"><Link className="button button-ink" href="/dividends">View the dividends <span>→</span></Link><Link className="button button-ghost" href="/docs">Read the docs</Link></div>
              <p className="hero-note"><i /> 3% trading fee · 90% allocated to stocks · push payouts</p>
            </div>
            <div className="hero-swap"><SwapPanel /></div>
          </div>
          {/* THE BAND UNDER THE HERO. It was a 3:1 render of coins; it is now the thirteen assets
              themselves, which is the same sentence told with the subject present. The two labels
              stay because they are what the band is FOR — fees in on one side, stocks out on the
              other — and the fan between them is the second half of that arrow.

              The render is kept in the repo rather than deleted: it is still the OG image's
              subject, and this swap is a layout decision that may want undoing. */}
          <div className={`flow-strip${HERO_STAGE && stageStocks.length > 0 ? " is-stage" : " is-render"}`}>
            {HERO_STAGE && stageStocks.length > 0 ? (
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

        <section className="stats-band" aria-label="Protocol economics"><div className="stats-inner">
          <div><span>Hook fee</span><strong>3%</strong><small>on STFY trades</small></div>
          <div><span>Stock allocation</span><strong>90%</strong><small>of hook fee</small></div>
          <div><span>LP fee</span><strong>1%</strong><small>to v4 liquidity providers</small></div>
          <div><span>Initial supply</span><strong>1B</strong><small>STFY fixed supply</small></div>
        </div></section>

        <section className="section wrap" id="how"><div className="section-head"><p className="eyebrow">THE DIVIDEND LOOP</p><h2>A stock dividend that starts with volume.</h2><p>Stockify does not reflect another token into your wallet. The vault acquires the B20 assets themselves and pushes the resulting entitlement to holders.</p></div><div className="steps-grid">{mechanics.map((step) => <article className="step-card" key={step.number}><RingMarker filled={step.filled} label={step.number} lit={step.lit} /><h3>{step.title}</h3><p>{step.copy}</p></article>)}</div></section>

        <section className="section wrap" id="index"><div className="index-showcase"><div className="section-head index-head"><div><p className="eyebrow">THE B20 STOCKS UNIVERSE</p><h2>Twenty-three listed. Five in the index.</h2></div><p>Every B20 equity Coinbase has issued on Base. The dividend vault buys a configurable subset of them, and the index can change between cycles.</p></div><IndexUniverse slices={slices} /></div>
          <StockGrid compact>
            {/* The two ways out sit IN the grid rather than under it: twenty-three assets across five
                columns leave exactly two empty cells, and an action shaped like the things it acts
                on reads as part of the set instead of as a banner below it. */}
            <Link className="equity-card is-action" href="/stocks">
              <span className="equity-name"><strong>All stocks</strong><span>Every B20 on Base</span></span>
            </Link>
            <Link className="equity-card is-action" href="/dividends">
              <span className="equity-name"><strong>The vault</strong><span>What it buys</span></span>
            </Link>
          </StockGrid>
        </section>

        {/* WHAT THIS SITE IS, in three lines, after the universe it is built on.
            Here rather than at the top because each one only means something once you know what a
            B20 stock is — the section above is the premise and this is the consequence. */}
        <section className="section wrap" id="products">
          <div className="section-head">
            <p className="eyebrow">FOUR WAYS IN</p>
            <h2>The hub for B20 stocks on Base.</h2>
            <p>
              One protocol that pays them out, one that turns any launch&apos;s fees into them, one
              place to look them up — and one place to spend them.
            </p>
          </div>
          <div className="product-grid">
            {products.map((product) => (
              <Link className="product-card" href={product.href} key={product.name}>
                {/* The NAME leads. It was the small label above the description, which made the
                    cards read as sentences that happened to be filed under something — and the
                    thing a visitor has to leave with is what these things are called. */}
                <strong className="product-name">{product.name}</strong>
                <span className="product-line">{product.line}</span>
                <p>{product.copy}</p>
                <b aria-hidden="true">→</b>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
