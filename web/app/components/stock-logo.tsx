type StockLogoProps = {
  stock: { symbol: string; domain?: string };
  /** The official Coinbase equity icon, read from the token's own `contractURI()`. */
  logo?: string;
  size?: "small" | "regular" | "large";
};

/**
 * The asset's mark, preferring the one the token names itself.
 *
 * `contractURI()` carries Coinbase's official equity icon, so an equity Base lists tomorrow arrives
 * correctly branded with nothing added to this repo. The favicon fallback covers the assets with no
 * on-chain icon to read — SPCXc has never set one. The surrounding ticker and name remain the
 * accessible label; this image is deliberately decorative.
 */
export function StockLogo({ stock, logo, size = "regular" }: StockLogoProps) {
  const src = logo ?? (stock.domain ? `https://www.google.com/s2/favicons?domain=${stock.domain}&sz=128` : undefined);
  return (
    <span className={`stock-logo stock-logo-${size}`} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" /> : <i>{stock.symbol.slice(0, 2)}</i>}
    </span>
  );
}
