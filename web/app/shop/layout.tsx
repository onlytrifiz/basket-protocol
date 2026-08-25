import type { Metadata } from "next";
import "../shop.css";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { ShopBar } from "../components/shop/shop-bar";
import { activeCountry } from "../../lib/shop/store";

/**
 * The shop, wrapped in the site.
 *
 * Same header and same footer as the protocol pages — this is a room in the
 * building, not a storefront bolted to the side. `shop.css` is imported here
 * rather than in globals so none of it is parsed by anyone who never comes
 * shopping.
 */
export const metadata: Metadata = {
  title: "Shop — gift cards, eSIM and top-ups for your stock",
  description:
    "Spend the tokenized stock your dividends paid out — Apple, NVIDIA, Alphabet, Meta — on gift cards, eSIM data and mobile top-ups. Delivered by email in minutes. No account, no ID, no bank.",
};

export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const country = await activeCountry();

  return (
    <div className="site-shell">
      <SiteHeader active="shop" />
      <main>
        <div className="wrap">
          <ShopBar country={country} />
        </div>
        {children}

        {/* Rendered here, so it appears on every shop page and on no other. The
            link is marked sponsored because it is: orders placed through it
            earn us a commission, and saying so in the markup costs nothing. */}
        <div className="wrap">
          <div className="sh-powered">
            <span className="who">
              <span className="k">Fulfilled by</span>
              <a
                href="https://www.cryptorefills.com"
                target="_blank"
                rel="sponsored noopener noreferrer"
              >
                <img src="/logos/cryptorefills.png" alt="CryptoRefills Labs" width={132} height={43} />
              </a>
            </span>
            <p>
              Gift cards, eSIM plans and mobile top-ups are supplied and delivered by CryptoRefills,
              and their terms govern what you buy. Paying for them with stock on Base is ours.{" "}
              <a href="/shop/terms">Shop terms →</a>
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
