/**
 * The cash legs' marks, drawn inline.
 *
 * Inline SVG rather than the usual CDN logo URLs: these sit next to the amount a user is about to
 * commit, and an icon that fails to load there reads as a broken panel at exactly the wrong moment.
 * They also cost no request and stay crisp at any size.
 *
 * Decorative — the ticker beside each one is the label, so they are hidden from assistive tech.
 */
export function CoinMark({ symbol, size = 18 }: { symbol: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 32 32", "aria-hidden": true, focusable: "false" as const };

  if (symbol === "ETH") {
    return (
      <svg {...common} className="coin-mark">
        <circle cx="16" cy="16" r="16" fill="#627EEA" />
        <path d="M16.5 4.2v8.9l7.5 3.4z" fill="#fff" fillOpacity=".6" />
        <path d="M16.5 4.2 9 16.5l7.5-3.4z" fill="#fff" />
        <path d="M16.5 22v5.8L24 17.9z" fill="#fff" fillOpacity=".6" />
        <path d="M16.5 27.8V22L9 17.9z" fill="#fff" />
        <path d="m16.5 20.6 7.5-4.1-7.5-3.4z" fill="#fff" fillOpacity=".2" />
        <path d="M9 16.5l7.5 4.1v-7.5z" fill="#fff" fillOpacity=".6" />
      </svg>
    );
  }

  if (symbol === "USDC") {
    return (
      <svg {...common} className="coin-mark">
        <circle cx="16" cy="16" r="16" fill="#2775CA" />
        <path
          d="M16 7v2.1M16 22.9V25"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M19.6 12.3c-.5-1.7-1.9-2.6-3.6-2.6-2.1 0-3.6 1.1-3.6 2.9 0 1.6 1.1 2.5 3.3 3l1.1.3c2.4.6 3.5 1.6 3.5 3.4 0 2-1.7 3.4-4 3.4-2.3 0-3.9-1.1-4.4-3"
          fill="none"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return null;
}
