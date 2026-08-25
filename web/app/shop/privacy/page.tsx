import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shop privacy",
  description: "What the shop collects, who it goes to, and what is deliberately not kept.",
};

const SUPPORT_URL = process.env.NEXT_PUBLIC_SUPPORT_URL ?? "https://t.me/basestocksalerts";

/**
 * Describes the data the code actually handles.
 *
 * The temptation with a storefront like this is to write "we are only a
 * wrapper, see the supplier's policy" and stop. That would be misleading: we
 * are the ones who take the email, and when a database is configured we keep
 * our own record of the order. A page that denied that would be contradicted by
 * the schema in lib/shop/db.ts, so it says so instead.
 */
export default function ShopPrivacyPage() {
  return (
    <div className="wrap sh-page" style={{ maxWidth: 760 }}>
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <span className="now">Privacy</span>
      </nav>

      <h1 className="sh-h1">Shop privacy</h1>
      <p className="sh-sub">
        What the shop collects, where it goes, and what it chooses not to keep. The rest of the site
        collects nothing — it reads the chain. Last updated August 2026.
      </p>

      <div className="doc" style={{ marginTop: 22 }}>
        <section>
          <h2>There is no account</h2>
          <p>
            There is no sign-up, no password and no identity check. We do not ask for your name,
            address or documents, and we do not run identity verification on buyers.
          </p>
        </section>

        <section>
          <h2>What is collected</h2>
          <ul>
            <li><strong>Your email.</strong> Required, because it is where the code is delivered.</li>
            <li>
              <strong>A phone number</strong> — only when you buy a mobile top-up, because that is
              what gets credited.
            </li>
            <li>
              <strong>Your wallet address</strong> — when you connect a wallet to pay. Blockchain
              transactions are public by nature and we do not control that.
            </li>
          </ul>
        </section>

        <section>
          <h2>Who it goes to</h2>
          <p>
            <strong>CryptoRefills</strong> supplies and delivers the gift cards, eSIM plans and
            top-ups. Your email — and the phone number for a top-up — is passed to them so they can
            fulfil the order, and their handling of it is governed by{" "}
            <a
              href="https://www.cryptorefills.com/en/privacy-policy"
              target="_blank"
              rel="noopener noreferrer nofollow"
              style={{ color: "var(--lime-deep)" }}
            >
              their privacy policy
            </a>
            .
          </p>
          <p>
            <strong>Velora</strong> prices and routes the swap that pays the order. It receives the
            wallet address you are paying from and the address the order is paid to — both of which
            are public on Base the moment the transaction is mined.
          </p>
          <p>We do not sell your data, and we do not share it beyond what an order needs.</p>
        </section>

        <section>
          <h2>What is kept here</h2>
          <p>
            A record of each order — what was bought, for how much, its status, and the email or
            phone it was delivered to — so we can answer questions about it and keep our own books.
          </p>
          <p>
            Redeem codes, PIN serials and security codes are deliberately <em>not</em> stored. Those
            are spendable on their own, so a leak of our records would be a leak of money. The
            supplier already stores and emails them.
          </p>
        </section>

        <section>
          <h2>Cookies</h2>
          <p>
            One cookie, storing the country whose catalogue you chose. There is no advertising or
            analytics tracking on this site.
          </p>
        </section>

        <section>
          <h2>Your rights</h2>
          <p>
            You can ask what we hold about you, ask for it to be corrected, or ask us to delete it.
            Since orders are identified by email, tell us the address you ordered with. We cannot
            delete anything from CryptoRefills or from a public blockchain — for the first, use their
            policy above; the second is permanent by design.
          </p>
        </section>

        <section>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            Requests and questions:{" "}
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--lime-deep)" }}>
              message us on Telegram
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
