import type { MarketPulse, PulseKpis } from "../../lib/blockworks";
import { usdCompact } from "../../lib/format";
import { MarketChart } from "./market-charts";
import { MarketTokenTable } from "./market-token-table";

/**
 * The market band's advance notice, attached under the stats band at the top of the page.
 *
 * The full section lives below the table, where a reader who came for the B20 list will not
 * scroll unprompted — and moving it above the table would put eight charts between a visitor and
 * the page's actual job. So the section stays put and this strip goes where the eyes already are:
 * one line of desk navy — literally the material of the band it links to — carrying the market's
 * headline numbers and an anchor. A reader who wants the context jumps; one who came to trade
 * scrolls straight past a 48px strip.
 *
 * Rendered only alongside the section itself: a signpost to a band that failed to load would be
 * worse than neither.
 */
export function MarketPulseTeaser({ kpis }: { kpis: PulseKpis }) {
  return (
    <a className="mkt-teaser" href="#market">
      <span className="mkt-teaser-inner">
        <span className="mkt-teaser-label">Also here · The whole Base market</span>
        <span className="mkt-teaser-copy">
          <b>{usdCompact(kpis.supplyUsd)}</b> of tokenized equities from <b>4</b> issuers — supply,
          DEX volume, lending and holders, charted below
        </span>
        <span className="mkt-teaser-go">Jump to the charts <i aria-hidden="true">↓</i></span>
      </span>
    </a>
  );
}

/**
 * The whole Base tokenized-equity market, under the B20 table that lists our slice of it.
 *
 * On the DESK, deliberately: the hub above is "our universe" on the light surface, and this is the
 * market it sits inside — every issuer, every venue — which is exactly the register the dark desk
 * exists for. It also keeps two white-card data surfaces from stacking on one page.
 *
 * Every card renders only if its widget answered (see `marketPulse`); the section owns no state and
 * no fetch — it draws what the page hands it.
 */
export function MarketPulseSection({ pulse }: { pulse: MarketPulse }) {
  const { kpis, tokens } = pulse;
  const asOf = new Date(`${pulse.asOf}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });

  return (
    <section aria-label="The whole Base tokenized-equity market" className="desk-panel mkt-band" id="market">
      <div className="desk-inner">
        <div className="desk-head">
          <div>
            <p className="eyebrow eyebrow-light">BASE · EVERY ISSUER</p>
            <h2>The market around tokenized stocks.</h2>
            <p className="mkt-lede">
              Coinbase is one of four issuers putting equities on Base — Backed, Centrifuge and
              Dinari mint here too. This is the whole market those tokens trade in: supply, DEX
              volume, lending and holders, across every issuer at once.
            </p>
          </div>
          <div className="desk-cycle">
            <div className="desk-cycle-meta">
              <span>Data through</span>
              <b>{asOf}</b>
            </div>
          </div>
        </div>

        <div className="desk-metrics mkt-metrics">
          <div>
            <span>Market supply</span>
            <strong>{usdCompact(kpis.supplyUsd)}</strong>
            <small>tokenized equities on Base</small>
          </div>
          <div>
            <span>Tokens live</span>
            <strong>{kpis.tokenCount}</strong>
            <small>{kpis.equityCount ? `across ${kpis.equityCount} underlying equities` : "listed on-chain"}</small>
          </div>
          <div>
            <span>Top issuer holds</span>
            <strong>{(kpis.topIssuerShare * 100).toFixed(1)}%</strong>
            <small>of all supply</small>
          </div>
          <div>
            <span>Issuers minting</span>
            <strong>4</strong>
            <small>Backed · Coinbase · Centrifuge · Dinari</small>
          </div>
        </div>

        <div className="mkt-grid">
          {pulse.totalSupply && (
            <MarketChart
              data={pulse.totalSupply}
              hint="USD value of every tokenized equity on Base"
              defaultRange="1y"
              kind="area"
              title="Circulating supply"
            />
          )}
          {pulse.supplyByIssuer && (
            <MarketChart
              data={pulse.supplyByIssuer}
              hint="Who minted the market, over time"
              defaultRange="1y"
              kind="stack"
              title="Supply by issuer"
            />
          )}
          {pulse.volumeByIssuer && (
            <MarketChart
              data={pulse.volumeByIssuer}
              hint="Weekly DEX volume by the token's issuer"
              defaultRange="6m"
              kind="bars"
              title="Volume by issuer"
              weekly
            />
          )}
          {pulse.volumeByDex && (
            <MarketChart
              data={pulse.volumeByDex}
              hint="Weekly volume by the venue it traded on"
              defaultRange="6m"
              kind="bars"
              title="Volume by DEX"
              weekly
            />
          )}
          {pulse.lendingByToken && (
            <MarketChart
              data={pulse.lendingByToken}
              hint="Tokenized equities posted as lending deposits"
              defaultRange="6m"
              kind="stack"
              title="In lending, by token"
            />
          )}
          {pulse.lendingByProtocol && (
            <MarketChart
              data={pulse.lendingByProtocol}
              hint="The same deposits, by protocol"
              defaultRange="6m"
              kind="stack"
              title="In lending, by protocol"
            />
          )}
          {pulse.holderVenues && (
            <MarketChart
              data={pulse.holderVenues}
              hint="USD supply sitting at each kind of venue"
              defaultRange="3m"
              kind="stack"
              title="Where the supply sits"
            />
          )}
          {pulse.holderCounts && (
            <MarketChart
              data={pulse.holderCounts}
              format="count"
              hint="Addresses holding the most-held tokens"
              defaultRange="3m"
              kind="lines"
              title="Holder counts"
            />
          )}
        </div>

        {tokens.length > 0 && <MarketTokenTable tokens={tokens} />}

        <p className="desk-note">
          Source: Blockworks — Base tokenized equities
        </p>
      </div>
    </section>
  );
}
