import type { BasketStock } from "../../lib/stocks";

type StockLogoProps = {
  stock: BasketStock;
  size?: "small" | "regular" | "large";
};

/**
 * Small official brand marks keep the B20 universe scannable without adding a
 * local image pipeline before launch. The surrounding ticker/name remains the
 * accessible label; this image is deliberately decorative.
 */
export function StockLogo({ stock, size = "regular" }: StockLogoProps) {
  return (
    <span className={`stock-logo stock-logo-${size}`} aria-hidden="true">
      <img src={`https://www.google.com/s2/favicons?domain=${stock.domain}&sz=128`} alt="" />
    </span>
  );
}
