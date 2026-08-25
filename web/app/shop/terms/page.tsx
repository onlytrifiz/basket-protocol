import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shop terms",
  description: "How buying works here, and whose terms apply to what you receive.",
};

const SUPPORT_URL = process.env.NEXT_PUBLIC_SUPPORT_URL ?? "https://t.me/basestocksalerts";

/**
 * Written to describe what the code actually does, not to sound official.
 *
 * The shop is a storefront over CryptoRefills, so their terms govern the
 * products and this page says so plainly. It does not say "everything is
 * theirs", because that is not true of every part: the payment is a swap on
 * Base through a third-party aggregator, signed by the buyer's own wallet.
 * Claiming otherwise would be tidier and wrong.
 */
export default function ShopTermsPage() {
  return (
    <div className="wrap sh-page" style={{ maxWidth: 760 }}>
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <span className="now">Terms</span>
      </nav>

      <h1 className="sh-h1">Shop terms</h1>
      <p className="sh-sub">
        A plain description of how buying here works. These cover the shop only — the token and the
        vault are described in the <a href="/docs" style={{ color: "var(--lime-deep)" }}>docs</a>.
        Last updated August 2026.
      </p>

      <div className="doc" style={{ marginTop: 22 }}>
        <section>
          <h2>What this is</h2>
          <p>
            The shop is a storefront. The gift cards, eSIM plans and mobile top-ups sold here are
            supplied and delivered by <strong>CryptoRefills</strong>, which sets the catalogue, the
            prices and the redemption rules, takes the payment, and sends you the code. We present
            their catalogue and let you pay for it from a chain they do not accept directly.
          </p>
          <p>
            Their terms are therefore the ones that govern what you buy. Read them before ordering:{" "}
            <a
              href="https://www.cryptorefills.com/en/terms-of-service"
              target="_blank"
              rel="noopener noreferrer nofollow"
              style={{ color: "var(--lime-deep)" }}
            >
              CryptoRefills Terms of Service
            </a>
            . Where anything on this page conflicts with theirs on a product they supply, theirs
            applies.
          </p>
        </section>

        <section>
          <h2>Paying</h2>
          <p>
            Orders are settled in a stablecoin on Base, which is a network CryptoRefills accepts and
            the network this protocol already runs on — so nothing is bridged. Whatever you pay with
            is sold for that stablecoin and delivered straight to the order&apos;s own address, in
            one transaction, routed by{" "}
            <a href="https://velora.xyz" target="_blank" rel="noopener noreferrer nofollow" style={{ color: "var(--lime-deep)" }}>
              Velora
            </a>
            , a third-party aggregator. You connect your own wallet and sign your own transaction;
            we never hold your funds and cannot move them. Paying in STFY is the one exception to
            &ldquo;one transaction&rdquo;: it is sold through the protocol&apos;s own router first,
            which is two signatures, and the shop says so before you start.
          </p>
          <p>
            An order settles only when at least the amount it asks for arrives at its address. The
            swap is priced to deliver an exact figure, and a small margin — a fraction of a percent,
            and at least a cent — is added on top so that rounding can never leave an order short.
            That margin is shown to you before you pay and is not refundable: it goes to the
            supplier as overpayment.
          </p>
          <p>
            What a payment costs beyond the face value is the aggregator&apos;s route, not a fee of
            ours. Selling STFY additionally pays the protocol&apos;s own 3% hook fee, the same as any
            other sale of it, and that fee buys stock for holders rather than accruing to this shop.
          </p>
          <p>
            Blockchain transfers cannot be reversed. An order that receives less than it asks for is
            not fulfilled automatically; CryptoRefills contacts you to complete or refund it.
          </p>
        </section>

        <section>
          <h2>What you receive</h2>
          <p>
            Redeem codes and PINs are bearer instruments: anyone holding the code can spend it. Keep
            them as you would cash. We do not store them, so we cannot recover one that is lost or
            shared.
          </p>
          <p>
            Mobile top-ups credit the phone number you enter and cannot be undone. Check the number
            before ordering — a top-up sent to the wrong number is gone.
          </p>
        </section>

        <section>
          <h2>Refunds and disputes</h2>
          <p>
            Refunds are handled by CryptoRefills under their terms. If an order does not arrive,
            contact us with the order number and we will chase it, but the decision and the refund
            are theirs to make.
          </p>
        </section>

        <section>
          <h2>Eligibility</h2>
          <p>
            You must be old enough to enter a contract where you live, and you must not use this shop
            where doing so breaks local law. You are responsible for any tax arising from what you
            buy.
          </p>
        </section>

        <section>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            Questions about an order:{" "}
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--lime-deep)" }}>
              message us on Telegram
            </a>
            . See also the <a href="/shop/privacy" style={{ color: "var(--lime-deep)" }}>shop privacy note</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
