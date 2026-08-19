/**
 * Number formatting for a page that shows two prices for the same company.
 *
 * The precision rules matter more than usual here: NVDAc trading at $220.33 against NVDA at $219.74
 * is a 0.27% premium, and rounding either to the dollar would erase the entire point of showing them
 * side by side.
 */

const USD = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: min, maximumFractionDigits: max });

const price2 = USD(2, 2);
const price4 = USD(2, 4);

/** A share price. Sub-dollar assets keep four decimals; nothing else needs them. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return (value < 1 ? price4 : price2).format(value);
}

/** A large dollar figure — liquidity, volume, market cap. Compact past four digits. */
export function usdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 1_000) return `$${value.toFixed(0)}`;
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [scale, suffix] of units) {
    if (value >= scale) {
      const scaled = value / scale;
      return `$${scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0)}${suffix}`;
    }
  }
  return `$${value.toFixed(0)}`;
}

/** A share count. `null` means the chain did not answer, which is not the same as zero. */
export function shares(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** A signed percentage, always with its sign so a gain never reads as a level. */
export function percent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/**
 * How far the on-chain price sits from the real share price.
 *
 * THE POINT OF THIS WHOLE PAGE. A tokenized equity is a claim on a share, so the honest question is
 * not "what does NVDAc cost" but "what does NVDAc cost compared to NVDA". Returns null unless both
 * sides are real numbers — a premium computed against a missing quote is worse than no premium.
 */
export function premium(onChain: number | null | undefined, reference: number | null | undefined): number | null {
  if (!onChain || !reference || !Number.isFinite(onChain) || !Number.isFinite(reference)) return null;
  return ((onChain - reference) / reference) * 100;
}

/** Relative time, for "quoted 4m ago" stamps. Seconds in, because that is what both APIs emit. */
export function since(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
