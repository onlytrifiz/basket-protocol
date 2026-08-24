import type { IndexTotals } from "../../lib/indices";
import { usdCompact } from "../../lib/format";

/**
 * What the whole set has done, in four figures.
 *
 * None of them is a term of service. The protocol's cut used to sit here and was the only tile that
 * never moved — what someone weighing this is actually asking is whether it reaches people, so the
 * count of payments actually made stands in its place.
 */
export function IndexStats({ totals }: { totals: IndexTotals }) {
  return (
    <section className="stats-band" aria-label="Every index">
      <div className="stats-inner">
        <div>
          {/* Both mechanisms are named, because the figure covers both: an index either pushes
              equity to holders or destroys the coin, and a tile headed with only the first would
              quietly count the second under a word that does not describe it. */}
          <span>Paid to holders / Bought back</span>
          <strong>
            {totals.returnedUsd === null || totals.returnedUsd === 0 ? "—" : usdCompact(totals.returnedUsd)}
          </strong>
          <small>across every index</small>
        </div>
        <div>
          <span>Indices</span>
          <strong>{totals.count}</strong>
          <small>
            {totals.withRounds > 0
              ? `${totals.withRounds} ${totals.withRounds === 1 ? "has" : "have"} paid a round`
              : "none has paid yet"}
          </small>
        </div>
        <div>
          <span>Rounds run</span>
          <strong>{totals.rounds}</strong>
          <small>every one of them on a schedule</small>
        </div>
        <div>
          <span>Payments made</span>
          <strong>{totals.payments.toLocaleString("en-US")}</strong>
          <small>one wallet, one round, each</small>
        </div>
      </div>
    </section>
  );
}
