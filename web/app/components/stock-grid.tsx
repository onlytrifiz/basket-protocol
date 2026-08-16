import { shortAddress, stocks } from "../../lib/stocks";
import { StockLogo } from "./stock-logo";

const explorer = "https://basescan.org/token/";

export function StockGrid({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`equity-grid${compact ? " equity-grid-compact" : ""}`}>
      {stocks.map((stock) => (
        <article className="equity-card" key={stock.symbol}>
          <div className="equity-top"><StockLogo stock={stock} /><span className="equity-tag">B20</span></div>
          <div className="equity-name"><strong>{stock.symbol}</strong><span>{stock.name}</span></div>
          <div className="equity-foot"><a href={`${explorer}${stock.address}`} target="_blank" rel="noreferrer">{shortAddress(stock.address)} ↗</a><span>{stock.referencePrice ?? "Route pending"}</span></div>
        </article>
      ))}
    </div>
  );
}
