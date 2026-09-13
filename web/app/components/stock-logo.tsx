import { spriteClass, spriteSafe } from "./logo-sprite";

type StockLogoProps = {
  stock: { symbol: string; domain?: string };
  /** The official Coinbase equity icon, read from the token's own `contractURI()`. */
  logo?: string;
  size?: "small" | "regular" | "large";
  /**
   * Draw the mark from a class rather than from an `src`.
   *
   * For a list that repeats the same handful of marks hundreds of times. The page must render
   * `<LogoSprite>` with the same marks, or the tile comes out blank — which is why this is opt-in
   * per surface instead of the default.
   */
  sprite?: boolean;
};

/**
 * The asset's mark, preferring the one the token names itself.
 *
 * `contractURI()` carries Coinbase's official equity icon, so an equity Base lists tomorrow arrives
 * correctly branded with nothing added to this repo. Every listed asset answers it today — SPCXc,
 * the last holdout, set one when SpaceX listed — so the favicon fallback now covers a read that did
 * not land rather than an issuer that never published, which is why it stays. The surrounding
 * ticker and name remain the accessible label; this image is deliberately decorative.
 */
export function StockLogo({ stock, logo, size = "regular", sprite = false }: StockLogoProps) {
  const src = logo ?? (stock.domain ? `https://www.google.com/s2/favicons?domain=${stock.domain}&sz=128` : undefined);
  // A URL the sprite refused is still a perfectly good `src` — it just does not go in a stylesheet.
  const sprited = sprite && spriteSafe(logo);
  return (
    <span className={`stock-logo stock-logo-${size}`} aria-hidden="true">
      {/* A <span>, not an <i>. `.stock-logo i` is the INITIALS fallback and paints itself with the
          `background` shorthand, which resets `background-image` to none — so a sprite sharing that
          element came out blank however correct its class was. */}
      {sprited
        ? <span className={`sl ${spriteClass(stock.symbol)}`} />
        : src ? <img src={src} alt="" loading="lazy" /> : <i>{stock.symbol.slice(0, 2)}</i>}
    </span>
  );
}
